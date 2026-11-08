import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DATABASE, type Database } from '../../src/db/database.module';
import { EventDispatcher } from '../../src/infra/outbox/event-dispatcher';
import { OutboxPublisher } from '../../src/infra/outbox/outbox.publisher';
import { requeueOutbox } from '../../src/infra/outbox/outbox-requeue';
import { WorkerRuntime } from '../../src/infra/outbox/worker-runtime';
import { WorkerModule } from '../../src/worker.module';
import { startHarness, type Harness } from '../identity/harness';

/**
 * `ops:outbox-requeue` (task 10-2 plan §4): after Redis was lost, the events published since
 * the snapshot that a consumer has not done go back on the queue, and take effect once.
 */

const EVENT = 'lead.requeue_tested';

let h: Harness;
let db: Database;
let worker: INestApplicationContext;
let runtime: WorkerRuntime;
let dispatcher: EventDispatcher;
const publisher = new OutboxPublisher({ [EVENT]: z.object({ n: z.number().int() }) });

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

const effects = async (consumer: string, eventId: string) =>
  (
    await h.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM test_requeue WHERE consumer = $1 AND event_id = $2',
      [consumer, eventId],
    )
  ).rows[0]?.n ?? 0;

/** A consumer's claim, as if it had done its part before Redis went. */
async function claim(consumer: string, eventId: string) {
  await h.owner.query(
    `INSERT INTO processed_events (event_id, consumer, event_created_at)
     SELECT id, $2, created_at FROM outbox_events WHERE id = $1`,
    [eventId, consumer],
  );
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const subscribers = (type: string) => dispatcher.subscribersOf(type);

beforeAll(async () => {
  h = await startHarness();
  db = h.app.get<Database>(DATABASE);
  await h.owner.query('CREATE TABLE test_requeue (event_id uuid NOT NULL, consumer text NOT NULL)');
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
  dispatcher = worker.get(EventDispatcher);
  for (const name of ['lead.requeue_a', 'lead.requeue_b']) {
    dispatcher.register({
      name,
      eventTypes: [EVENT],
      async handle(event, tx) {
        await tx.execute(
          sql`INSERT INTO test_requeue (event_id, consumer) VALUES (${event.id}, ${name})`,
        );
      },
    });
  }
  runtime = worker.get(WorkerRuntime);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await h.close();
});

describe('the outbox re-queue after Redis was lost', () => {
  it('sends again what a consumer has not done, once; reads Postgres only; never before since', async () => {
    // Published long before the snapshot: out of reach.
    const [old = ''] = await publish(0);
    expect((await runtime.relayOnce()).published).toBe(1);
    await h.owner.query(
      `UPDATE outbox_events SET published_at = now() - interval '2 days' WHERE id = $1`,
      [old],
    );
    const since = new Date(Date.now() - 60_000);

    // Three events published (in Redis), none consumed yet: the worker is not started.
    const [one = '', two = '', three = ''] = await publish(1, 2, 3);
    expect((await runtime.relayOnce()).published).toBe(3);
    // `three` was done by both consumers, `two` by one of them, before Redis went.
    await claim('lead.requeue_a', two);
    await claim('lead.requeue_a', three);
    await claim('lead.requeue_b', three);

    // Redis still has the jobs: nothing to send.
    expect(await requeueOutbox(db, runtime.outboxQueue, subscribers, since)).toEqual({
      examined: 3,
      done: 1,
      stillQueued: 2,
      requeued: 0,
    });

    // Redis is lost.
    await runtime.outboxQueue.obliterate({ force: true });
    expect(await runtime.outboxQueue.getJobCounts('waiting')).toEqual({ waiting: 0 });
    const outboxBefore = (
      await h.owner.query('SELECT id, published_at, attempts FROM outbox_events ORDER BY id')
    ).rows;
    const claimsBefore = (
      await h.owner.query('SELECT event_id, consumer FROM processed_events ORDER BY 1, 2')
    ).rows;

    // A dry run counts, adds nothing.
    expect(
      await requeueOutbox(db, runtime.outboxQueue, subscribers, since, { dryRun: true }),
    ).toEqual({ examined: 3, done: 1, stillQueued: 0, requeued: 2 });
    expect(await runtime.outboxQueue.getJobCounts('waiting')).toEqual({ waiting: 0 });

    expect(await requeueOutbox(db, runtime.outboxQueue, subscribers, since)).toEqual({
      examined: 3,
      done: 1,
      stillQueued: 0,
      requeued: 2,
    });
    const waiting = await runtime.outboxQueue.getJobs(['waiting']);
    expect(waiting.map((j) => j.id).sort()).toEqual([one, two].sort());
    expect(waiting.find((j) => j.id === one)?.data).toMatchObject({
      id: one,
      type: EVENT,
      payload: { n: 1 },
    });
    // Run again at once: the jobs are there; nothing added twice.
    expect((await requeueOutbox(db, runtime.outboxQueue, subscribers, since)).stillQueued).toBe(2);
    expect(await runtime.outboxQueue.getJobCounts('waiting')).toEqual({ waiting: 2 });

    // Postgres was only read.
    expect(
      (await h.owner.query('SELECT id, published_at, attempts FROM outbox_events ORDER BY id'))
        .rows,
    ).toEqual(outboxBefore);
    expect(
      (await h.owner.query('SELECT event_id, consumer FROM processed_events ORDER BY 1, 2')).rows,
    ).toEqual(claimsBefore);

    // The worker consumes: each consumer's part once, the one done before skipped.
    await runtime.start();
    await waitFor(async () => (await effects('lead.requeue_b', two)) === 1);
    await waitFor(async () => (await effects('lead.requeue_b', one)) === 1);
    expect(await effects('lead.requeue_a', one)).toBe(1);
    expect(await effects('lead.requeue_a', two)).toBe(0);
    expect(await effects('lead.requeue_a', three)).toBe(0);
    expect(await effects('lead.requeue_b', three)).toBe(0);
    expect(await effects('lead.requeue_a', old)).toBe(0);
  });

  it('refuses a since in the future or beyond 30 days', async () => {
    const now = new Date();
    await expect(
      requeueOutbox(db, runtime.outboxQueue, subscribers, new Date(now.getTime() + 60_000)),
    ).rejects.toThrow('since must be a time in the past');
    await expect(
      requeueOutbox(
        db,
        runtime.outboxQueue,
        subscribers,
        new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
      ),
    ).rejects.toThrow('within the last 30 days');
    await expect(
      requeueOutbox(db, runtime.outboxQueue, subscribers, new Date('not a time')),
    ).rejects.toThrow('since must be a time in the past');
  });
});
