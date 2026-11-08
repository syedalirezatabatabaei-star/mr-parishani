import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DATABASE, type Database } from '../../src/db/database.module';
import { createPool } from '../../src/db/pool';
import type { Alert, AlertSink } from '../../src/infra/ops/alerts';
import { QueueMonitor } from '../../src/infra/ops/queue-monitor';
import { EventDispatcher } from '../../src/infra/outbox/event-dispatcher';
import { OutboxPublisher } from '../../src/infra/outbox/outbox.publisher';
import { relayOnce } from '../../src/infra/outbox/outbox-relay';
import {
  BOOKING_SWEEP_JOB,
  HOLIDAY_COVERAGE_JOB,
  LEDGER_RECONCILIATION_JOB,
  MAINTENANCE_QUEUE,
  PARTITION_MAINTENANCE_JOB,
  QUEUE_MONITOR_JOB,
  SEARCH_REFRESH_JOB,
  MEDIA_PROCESS_JOB,
  CATALOG_IMPORT_JOB,
  CREDIT_SWEEP_JOB,
  SERVICE_SWEEP_JOB,
  ACCOUNT_MOBILE_CHECK_JOB,
  PROVIDER_CONTRACT_CHECK_JOB,
  DOWN_PAYMENT_RECONCILIATION_JOB,
  SETTLEMENT_DUE_JOB,
  SETTLEMENT_RECONCILIATION_JOB,
  SETTLEMENT_STATEMENTS_JOB,
  SMS_CAMPAIGN_JOB,
  TICKET_SWEEP_JOB,
  REPORT_EXPORT_JOB,
  REPORT_REFRESH_JOB,
  AUDIT_CHAIN_JOB,
  PERSON_MOBILE_EXPIRY_JOB,
  SMS_DELIVERY_JOB,
  SMS_RELEASE_JOB,
  REPAYMENT_CYCLE_JOB,
  REPAYMENT_REMINDERS_JOB,
  COLLECTION_CYCLE_JOB,
  PROFORMA_EXPIRY_JOB,
  WorkerRuntime,
} from '../../src/infra/outbox/worker-runtime';
import { WorkerModule } from '../../src/worker.module';
import { call, startHarness, type Harness } from '../identity/harness';

const EVENT = 'lead.test_happened';

let h: Harness;
let app: Pool;
let db: Database;
let worker: INestApplicationContext;
let runtime: WorkerRuntime;
const publisher = new OutboxPublisher({ [EVENT]: z.object({ n: z.number().int() }) });
const alerts: Alert[] = [];
/** Job ids whose processing "crashes" right after the consumer committed. */
const crashAfterCommit = new Set<string>();

const recordingSink: AlertSink = {
  raise(alert) {
    alerts.push(alert);
    return Promise.resolve();
  },
};

/** Publishes events in one committed transaction; returns their ids. */
async function publish(...ns: number[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const n of ns) {
      ids.push(
        await publisher.publish(
          { type: EVENT, aggregateType: 'test', aggregateId: String(n), payload: { n } },
          tx,
        ),
      );
    }
    return ids;
  });
}

async function effectsOf(eventId: string): Promise<number> {
  const { rows } = await h.owner.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM test_effects WHERE event_id = $1',
    [eventId],
  );
  return rows[0]?.n ?? 0;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Relays until nothing is pending. */
async function drain(): Promise<void> {
  for (;;) {
    const { published, failed } = await runtime.relayOnce();
    if (published === 0 && failed === 0) return;
  }
}

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
  db = h.app.get<Database>(DATABASE);
  // What a consumer does: a side effect in the consumer's transaction.
  await h.owner.query('CREATE TABLE test_effects (event_id uuid NOT NULL, n integer NOT NULL)');

  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot({
      alertSink: recordingSink,
      relayLoop: false,
      afterDispatch: (job: Job) => {
        if (job.id && crashAfterCommit.delete(job.id)) throw new Error('worker crashed');
      },
    }),
    { logger: false },
  );
  worker.get(EventDispatcher).register({
    name: 'lead.test_effects',
    eventTypes: [EVENT],
    async handle(event, tx) {
      const { n } = event.payload as { n: number };
      await tx.execute(sql`INSERT INTO test_effects (event_id, n) VALUES (${event.id}, ${n})`);
    },
  });
  runtime = worker.get(WorkerRuntime);
  await runtime.start();
});

afterAll(async () => {
  await worker.close();
  await app.end();
  await h.close();
});

describe('writing events', () => {
  it('a rolled-back change leaves no event; a committed one leaves exactly one', async () => {
    await expect(
      db.transaction(async (tx) => {
        await publisher.publish(
          { type: EVENT, aggregateType: 'test', aggregateId: 'rollback', payload: { n: 1 } },
          tx,
        );
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    const count = async (id: string) =>
      (
        await h.owner.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1',
          [id],
        )
      ).rows[0]?.n;
    expect(await count('rollback')).toBe(0);

    await db.transaction((tx) =>
      publisher.publish(
        { type: EVENT, aggregateType: 'test', aggregateId: 'commit', payload: { n: 2 } },
        tx,
      ),
    );
    expect(await count('commit')).toBe(1);
    await drain();
  });

  it('refuses an unknown type or a payload that does not fit, naming no value', async () => {
    await expect(
      db.transaction((tx) =>
        publisher.publish(
          { type: 'lead.unknown', aggregateType: 'test', aggregateId: 'x', payload: {} },
          tx,
        ),
      ),
    ).rejects.toThrow('unknown event type');
    await expect(
      db.transaction((tx) =>
        publisher.publish(
          { type: EVENT, aggregateType: 'test', aggregateId: 'x', payload: { n: 'secret-value' } },
          tx,
        ),
      ),
    ).rejects.toThrow(/at: n$/);
  });
});

describe('ACCEPTANCE: with simulated crashes, no event is lost or takes effect twice', () => {
  it('the relay dies after enqueueing, before recording it: the event takes effect once', async () => {
    const [id = ''] = await publish(10);
    await expect(
      runtime.relayOnce({
        afterEnqueue: () => {
          throw new Error('relay crashed');
        },
      }),
    ).rejects.toThrow('relay crashed');
    // Its bookkeeping rolled back: still unpublished, though the job reached the queue.
    const { rows } = await h.owner.query('SELECT published_at FROM outbox_events WHERE id = $1', [
      id,
    ]);
    expect(rows[0]).toEqual({ published_at: null });
    expect(await runtime.outboxQueue.getJob(id)).toBeDefined();

    // The restarted relay sends it again; the queue drops the duplicate job id.
    await drain();
    await waitFor(async () => (await effectsOf(id)) === 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await effectsOf(id)).toBe(1);
  });

  it('the worker dies after the consumer committed, before acknowledging: redelivered, applied once', async () => {
    const [id = ''] = await publish(20);
    crashAfterCommit.add(id);
    await drain();
    const job = await waitFor(async () => {
      const j = await runtime.outboxQueue.getJob(id);
      return (await j?.isCompleted()) ?? false;
    }, 30_000).then(() => runtime.outboxQueue.getJob(id));
    expect(job?.attemptsMade).toBe(2);
    expect(job?.returnvalue).toEqual([]); // the retry found the consumer already done
    expect(await effectsOf(id)).toBe(1);
  }, 40_000);

  it('Redis is down: events wait in the database and are delivered once it is back', async () => {
    const [id = ''] = await publish(30);
    const deadQueue = new Queue('outbox', {
      connection: {
        host: '127.0.0.1',
        port: 1,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      },
    });
    deadQueue.on('error', () => undefined);
    try {
      const result = await relayOnce(db, deadQueue);
      expect(result.failed).toBeGreaterThan(0);
    } finally {
      await deadQueue.close().catch(() => undefined);
    }
    const { rows } = await h.owner.query<{ attempts: number; published_at: Date | null }>(
      'SELECT attempts, published_at FROM outbox_events WHERE id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ attempts: 1, published_at: null });

    // Back again (and past its retry delay): delivered, once.
    await h.owner.query('UPDATE outbox_events SET available_at = now() WHERE id = $1', [id]);
    await drain();
    await waitFor(async () => (await effectsOf(id)) === 1);
  });

  it('two relays at once, 200 events: every one takes effect exactly once', async () => {
    const ids = await publish(...Array.from({ length: 200 }, (_, i) => 1000 + i));
    const relayUntilEmpty = async () => {
      for (;;) {
        const { published } = await runtime.relayOnce();
        if (published === 0) return;
      }
    };
    await Promise.all([relayUntilEmpty(), relayUntilEmpty()]);
    await waitFor(async () => {
      const { rows } = await h.owner.query<{ n: number }>(
        'SELECT count(DISTINCT event_id)::int AS n FROM test_effects WHERE event_id = ANY($1)',
        [ids],
      );
      return rows[0]?.n === 200;
    });
    const { rows } = await h.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM test_effects WHERE event_id = ANY($1)',
      [ids],
    );
    expect(rows[0]?.n).toBe(200);
    const pending = await h.owner.query(
      'SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL',
    );
    expect(pending.rows[0]).toEqual({ n: 0 });
  }, 40_000);
});

describe('the tables keep their history', () => {
  it('an event never changes and is never deleted; processed_events is append-only', async () => {
    await expect(app.query("UPDATE outbox_events SET payload = '{}'")).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.query('DELETE FROM outbox_events')).rejects.toMatchObject({ code: '42501' });
    await expect(h.owner.query('DELETE FROM outbox_events')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.query("UPDATE processed_events SET consumer = 'x'")).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('scheduled jobs', () => {
  it('are registered once: partition maintenance daily, the queue monitor every minute', async () => {
    const maintenance = new Queue(MAINTENANCE_QUEUE, {
      connection: { url: h.redisContainer.getConnectionUrl() },
    });
    try {
      const schedulers = await maintenance.getJobSchedulers();
      expect(schedulers.map((s) => s.key).sort()).toEqual(
        [
          PARTITION_MAINTENANCE_JOB,
          QUEUE_MONITOR_JOB,
          LEDGER_RECONCILIATION_JOB,
          HOLIDAY_COVERAGE_JOB,
          BOOKING_SWEEP_JOB,
          SEARCH_REFRESH_JOB,
          MEDIA_PROCESS_JOB,
          CATALOG_IMPORT_JOB,
          PROFORMA_EXPIRY_JOB,
          CREDIT_SWEEP_JOB,
          SERVICE_SWEEP_JOB,
          ACCOUNT_MOBILE_CHECK_JOB,
          PROVIDER_CONTRACT_CHECK_JOB,
          DOWN_PAYMENT_RECONCILIATION_JOB,
          SETTLEMENT_DUE_JOB,
          SETTLEMENT_RECONCILIATION_JOB,
          SETTLEMENT_STATEMENTS_JOB,
          SMS_RELEASE_JOB,
          SMS_DELIVERY_JOB,
          REPAYMENT_CYCLE_JOB,
          REPAYMENT_REMINDERS_JOB,
          COLLECTION_CYCLE_JOB,
          SMS_CAMPAIGN_JOB,
          TICKET_SWEEP_JOB,
          REPORT_EXPORT_JOB,
          REPORT_REFRESH_JOB,
          AUDIT_CHAIN_JOB,
          PERSON_MOBILE_EXPIRY_JOB,
        ].sort(),
      );
      // The appointment scheduler (task 2-6): holds lapse and reminders fall due by the minute.
      expect(schedulers.find((s) => s.key === BOOKING_SWEEP_JOB)?.every).toBe(60_000);
      // The search index refresher (task 2-7): events mark entries due; this computes them.
      expect(schedulers.find((s) => s.key === SEARCH_REFRESH_JOB)?.every).toBe(15_000);
      // The profile media job (task 2-8): scanning, variants and the public space.
      expect(schedulers.find((s) => s.key === MEDIA_PROCESS_JOB)?.every).toBe(10_000);
      // The import of centers and doctors (task 2-9).
      expect(schedulers.find((s) => s.key === CATALOG_IMPORT_JOB)?.every).toBe(10_000);
      // Proformas past their deadline (task 3-4) and credit deadlines and expiry (task 3-5).
      expect(schedulers.find((s) => s.key === PROFORMA_EXPIRY_JOB)?.every).toBe(15 * 60_000);
      expect(schedulers.find((s) => s.key === CREDIT_SWEEP_JOB)?.every).toBe(15 * 60_000);
      // Service authorizations expiring and deliveries becoming final (task 4-6).
      expect(schedulers.find((s) => s.key === SERVICE_SWEEP_JOB)?.every).toBe(60_000);
      // Down payments' reconciliation, nightly after the ledger's (task 4-6b).
      // Settlement (task 5-1): payables fall due hourly; reconciled nightly after the rest.
      expect(schedulers.find((s) => s.key === SETTLEMENT_DUE_JOB)).toMatchObject({
        pattern: '5 * * * *',
        tz: 'Asia/Tehran',
      });
      expect(schedulers.find((s) => s.key === SETTLEMENT_RECONCILIATION_JOB)).toMatchObject({
        pattern: '20 2 * * *',
        tz: 'Asia/Tehran',
      });
      // The installment cycle, nightly just after midnight Tehran (task 6-1).
      expect(schedulers.find((s) => s.key === REPAYMENT_CYCLE_JOB)).toMatchObject({
        pattern: '5 0 * * *',
        tz: 'Asia/Tehran',
      });
      // The overdue queue, nightly after the installment cycle (task 6-7).
      expect(schedulers.find((s) => s.key === COLLECTION_CYCLE_JOB)).toMatchObject({
        pattern: '20 0 * * *',
        tz: 'Asia/Tehran',
      });
      // Reminders and overdue notices, daily in the morning Tehran (task 6-6).
      expect(schedulers.find((s) => s.key === REPAYMENT_REMINDERS_JOB)).toMatchObject({
        pattern: '0 8 * * *',
        tz: 'Asia/Tehran',
      });
      // SMS (task 6-4): what is due queued often; delivery reports read every 10 minutes.
      expect(schedulers.find((s) => s.key === SMS_RELEASE_JOB)?.every).toBe(15_000);
      expect(schedulers.find((s) => s.key === SMS_DELIVERY_JOB)?.every).toBe(10 * 60_000);
      // Bulk SMS sent gradually (task 6-5).
      expect(schedulers.find((s) => s.key === SMS_CAMPAIGN_JOB)?.every).toBe(15_000);
      // Tickets (task 7-1): assignment, deadline alerts and closing, every five minutes.
      expect(schedulers.find((s) => s.key === TICKET_SWEEP_JOB)?.every).toBe(300_000);
      // Queued exports and PDFs (task 7-3), every ten seconds.
      expect(schedulers.find((s) => s.key === REPORT_EXPORT_JOB)?.every).toBe(10_000);
      // The reports' materialized views (task 7-4; 7.6), every fifteen minutes.
      expect(schedulers.find((s) => s.key === REPORT_REFRESH_JOB)?.every).toBe(900_000);
      // Pending mobiles past their deadline refused (task 9-3, م۵), every fifteen minutes.
      expect(schedulers.find((s) => s.key === PERSON_MOBILE_EXPIRY_JOB)?.every).toBe(900_000);
      // The audit trail's hash chain, nightly (task 9-3, R6).
      expect(schedulers.find((s) => s.key === AUDIT_CHAIN_JOB)).toMatchObject({
        pattern: '30 3 * * *',
        tz: 'Asia/Tehran',
      });
      // Last month's statements, daily after midnight (task 5-4).
      expect(schedulers.find((s) => s.key === SETTLEMENT_STATEMENTS_JOB)).toMatchObject({
        pattern: '30 0 * * *',
        tz: 'Asia/Tehran',
      });
      expect(schedulers.find((s) => s.key === DOWN_PAYMENT_RECONCILIATION_JOB)).toMatchObject({
        pattern: '10 2 * * *',
        tz: 'Asia/Tehran',
      });
      // Accounts without a verified mobile, daily (task 4-6).
      expect(schedulers.find((s) => s.key === ACCOUNT_MOBILE_CHECK_JOB)).toMatchObject({
        pattern: '0 9 * * *',
        tz: 'Asia/Tehran',
      });
      const reconciliation = schedulers.find((s) => s.key === LEDGER_RECONCILIATION_JOB);
      expect(reconciliation).toMatchObject({ pattern: '0 2 * * *', tz: 'Asia/Tehran' });
      expect(schedulers.find((s) => s.key === HOLIDAY_COVERAGE_JOB)).toMatchObject({
        pattern: '0 9 * * *',
        tz: 'Asia/Tehran',
      });
      expect(schedulers.find((s) => s.key === PARTITION_MAINTENANCE_JOB)?.pattern).toBe(
        '0 3 * * *',
      );
    } finally {
      await maintenance.close();
    }
  });

  it('partition maintenance runs as the application role, within guard rails', async () => {
    const month = (offset: number) => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + offset);
      return d.toISOString().slice(0, 10);
    };
    await expect(
      app.query("SELECT maintain_monthly_partitions(ARRAY['user_accounts'], $1, 1, '2000-01-01')", [
        month(0),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query("SELECT maintain_monthly_partitions(ARRAY['outbox_events'], $1, 1, $1)", [
        month(0),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const ok = await app.query<{ r: { created: number } }>(
      "SELECT maintain_monthly_partitions(ARRAY['outbox_events', 'processed_events'], $1, 14, '2000-01-01') AS r",
      [month(0)],
    );
    // The 14th month did not exist yet (the migration made 13).
    expect(ok.rows[0]?.r.created).toBe(2);
  });
});

describe('queue monitoring', () => {
  it('alerts when the oldest unpublished event waits too long', async () => {
    await publish(40);
    const monitor = worker.get(QueueMonitor);
    const later = new Date(Date.now() + 10 * 60 * 1000);
    const snapshot = await monitor.check(runtime.watchedQueues, later);
    expect(snapshot.outboxPending).toBeGreaterThan(0);
    expect(snapshot.alerts.map((a) => a.code)).toContain('outbox_stale');
    expect(alerts.map((a) => a.code)).toContain('outbox_stale');
    expect(snapshot.queues['outbox']).toBeDefined();

    await drain();
    const calm = await monitor.check(runtime.watchedQueues);
    expect(calm.outboxPending).toBe(0);
    expect(calm.alerts.filter((a) => a.code.startsWith('outbox'))).toEqual([]);
  });

  it('alerts on a failed job', async () => {
    // A job the consumer cannot parse fails for good (no retry for a malformed envelope).
    await runtime.outboxQueue.add(
      'lead.test_happened',
      { not: 'an envelope' },
      { jobId: 'broken-1' },
    );
    await waitFor(
      async () => (await (await runtime.outboxQueue.getJob('broken-1'))?.isFailed()) ?? false,
    );
    const snapshot = await worker.get(QueueMonitor).check(runtime.watchedQueues);
    expect(snapshot.alerts).toContainEqual(expect.objectContaining({ code: 'queue_failed' }));
    await drain();
  });
});

describe('health', () => {
  it('answers live and ready without a session', async () => {
    expect(await call(h, 'GET', '/health/live')).toMatchObject({
      status: 200,
      body: { status: 'ok' },
    });
    expect(await call(h, 'GET', '/health/ready')).toMatchObject({
      status: 200,
      body: { status: 'ok', checks: { database: 'ok', redis: 'ok' } },
    });
  });
});
