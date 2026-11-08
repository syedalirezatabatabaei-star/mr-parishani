import type { EventEnvelope } from '@sepehr/contracts';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/database.module';

/** How a relayed job is retried and kept. */
export const OUTBOX_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 5_000 },
  // Kept a week: re-relaying an event whose job still exists is a no-op (same job id),
  // which is what makes a relay crash between enqueue and bookkeeping harmless.
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  // A job that failed for good stays visible (and alerts) until someone deals with it.
  removeOnFail: false,
} as const;

export interface RelayResult {
  readonly published: number;
  readonly failed: number;
}

/** Test hook: runs after the jobs are enqueued, before the rows are marked published. */
export interface RelayFaults {
  readonly afterEnqueue?: () => void;
}

interface PendingRow extends Record<string, unknown> {
  id: string;
  created_iso: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
}

/**
 * Moves committed events from outbox_events to the queue. Rows are locked with SKIP
 * LOCKED, so any number of relays can run: none takes a row another holds. The job id is
 * the event id, so enqueueing the same event again (after a crash) adds nothing. A row is
 * marked published only after its job is in Redis; if Redis is down the row stays and
 * is retried later, with growing delay.
 */
export async function relayOnce(
  db: Database,
  queue: Queue,
  batchSize = 100,
  faults: RelayFaults = {},
): Promise<RelayResult> {
  return db.transaction(async (tx) => {
    const pending = await tx.execute<PendingRow>(sql`
      SELECT id, event_type, aggregate_type, aggregate_id, payload, attempts,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_iso
      FROM outbox_events
      WHERE published_at IS NULL AND available_at <= now()
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `);
    const published: string[] = [];
    let failed = 0;
    for (const row of pending.rows) {
      const envelope: EventEnvelope = {
        id: row.id,
        type: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.created_iso,
      };
      try {
        await queue.add(row.event_type, envelope, { ...OUTBOX_JOB_OPTIONS, jobId: row.id });
        published.push(row.id);
      } catch (error) {
        failed++;
        const delaySeconds = Math.min(2 ** row.attempts * 5, 300);
        const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
        await tx.execute(sql`
          UPDATE outbox_events
          SET attempts = attempts + 1, last_error = ${message},
              available_at = now() + make_interval(secs => ${delaySeconds})
          WHERE id = ${row.id}
        `);
      }
    }
    faults.afterEnqueue?.();
    if (published.length > 0) {
      await tx.execute(sql`
        UPDATE outbox_events SET published_at = now()
        WHERE id IN (${sql.join(
          published.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND published_at IS NULL
      `);
    }
    return { published: published.length, failed };
  });
}
