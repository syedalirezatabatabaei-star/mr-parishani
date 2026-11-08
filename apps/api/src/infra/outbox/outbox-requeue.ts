import type { EventEnvelope } from '@sepehr/contracts';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/database.module';
import { OUTBOX_JOB_OPTIONS } from './outbox-relay';

/**
 * How far back a re-queue may reach. Far inside the partitions' retention
 * (ops.outbox_retention, six months): a consumer's claim in processed_events must still be
 * there to be read, or an event done long ago would look undone.
 */
export const REQUEUE_MAX_AGE_DAYS = 30;

const BATCH = 500;

export interface RequeueResult {
  /** Published since `since`. */
  readonly examined: number;
  /** Every consumer of theirs has its claim: done, nothing to send. */
  readonly done: number;
  /** A consumer without its claim, and the job still in Redis: left as it is. */
  readonly stillQueued: number;
  /** A consumer without its claim, and no job: added again (or would be, on a dry run). */
  readonly requeued: number;
}

interface PublishedRow extends Record<string, unknown> {
  id: string;
  created_iso: string;
  published_iso: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  claimed: string[];
}

/**
 * After Redis was lost (task 10-2 plan §4): the events the relay published since `since`
 * that a consumer of theirs has not claimed in processed_events, and whose job is gone, go
 * back on the queue with their own id as the job id, as the relay sent them. Postgres is
 * only read. Sending again is harmless: each consumer claims (event, consumer) in its own
 * transaction, so a consumer that did its part is skipped.
 */
export async function requeueOutbox(
  db: Database,
  queue: Queue,
  subscribersOf: (type: string) => readonly string[],
  since: Date,
  options: { readonly dryRun?: boolean; readonly now?: Date } = {},
): Promise<RequeueResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(since.getTime()) || since > now) {
    throw new Error('since must be a time in the past');
  }
  if (now.getTime() - since.getTime() > REQUEUE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error(`since must be within the last ${String(REQUEUE_MAX_AGE_DAYS)} days`);
  }
  let examined = 0;
  let done = 0;
  let stillQueued = 0;
  let requeued = 0;
  // Keyset pages: (published_at, id) after the last one read.
  let after = { publishedAt: since.toISOString(), id: '00000000-0000-0000-0000-000000000000' };
  for (;;) {
    const { rows } = await db.execute<PublishedRow>(sql`
      SELECT o.id, o.event_type, o.aggregate_type, o.aggregate_id, o.payload,
             to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_iso,
             to_char(o.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_iso,
             coalesce((SELECT array_agg(p.consumer) FROM processed_events p
                       WHERE p.event_id = o.id AND p.event_created_at = o.created_at),
                      '{}') AS claimed
      FROM outbox_events o
      WHERE o.published_at IS NOT NULL
        AND (o.published_at, o.id) > (${after.publishedAt}::timestamptz, ${after.id}::uuid)
      ORDER BY o.published_at, o.id
      LIMIT ${BATCH}
    `);
    for (const row of rows) {
      examined++;
      const claimed = new Set(row.claimed);
      if (subscribersOf(row.event_type).every((name) => claimed.has(name))) {
        done++;
        continue;
      }
      if (await queue.getJob(row.id)) {
        stillQueued++;
        continue;
      }
      requeued++;
      if (options.dryRun) continue;
      const envelope: EventEnvelope = {
        id: row.id,
        type: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.created_iso,
      };
      await queue.add(row.event_type, envelope, { ...OUTBOX_JOB_OPTIONS, jobId: row.id });
    }
    const last = rows.at(-1);
    if (!last || rows.length < BATCH) break;
    after = { publishedAt: last.published_iso, id: last.id };
  }
  return { examined, done, stillQueued, requeued };
}
