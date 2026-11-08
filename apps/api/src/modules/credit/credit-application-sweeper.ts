import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import { creditApplications, creditApplicationStatusChanges } from './credit.schema';

type ApplicationRow = typeof creditApplications.$inferSelect;

const DAY_MS = 86_400_000;
const BATCH = 200;
const SWEEPER: Actor = { accountId: null, sessionId: null, ip: null, roles: ['credit'] };
/** States in review, whose deadline runs (doc 10 §4). */
const IN_REVIEW = ['ready_for_review', 'scoring', 'manual_review'] as const;

export interface CreditSweepResult {
  readonly slaBreached: number;
  readonly expired: number;
}

/**
 * What time does to credit applications (task 3-5, doc 10 §4), run by the worker every
 * 15 minutes, each row in its own transaction, skipping rows another pass holds:
 *
 * - an application in review past `sla_due_at` is announced once (`credit.sla_breached`,
 *   for the queue manager; doc 10 §10 test 14);
 * - a draft or incomplete one older than `credit.incomplete_expiry_days` expires.
 */
@Injectable()
export class CreditApplicationSweeper {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  async run(now = new Date()): Promise<CreditSweepResult> {
    const days = (await this.config.resolve('credit.incomplete_expiry_days', {}, now)).value;
    const slaBreached = await this.each(
      and(
        inArray(creditApplications.status, [...IN_REVIEW]),
        lte(creditApplications.slaDueAt, now),
        isNull(creditApplications.slaBreachedAt),
      ),
      async (tx, row) => {
        await tx
          .update(creditApplications)
          .set({ slaBreachedAt: now })
          .where(eq(creditApplications.id, row.id));
        await this.audit.record(
          {
            actor: SWEEPER,
            action: 'credit.sla_breached',
            entityType: 'credit_application',
            entityId: row.id,
            after: { slaDueAt: row.slaDueAt?.toISOString(), status: row.status },
          },
          tx,
        );
        await this.publish(tx, 'credit.sla_breached', row);
      },
    );
    const expired = await this.each(
      and(
        inArray(creditApplications.status, ['draft', 'incomplete']),
        lte(creditApplications.createdAt, new Date(now.getTime() - days * DAY_MS)),
      ),
      async (tx, row) => {
        await tx
          .update(creditApplications)
          .set({ status: 'expired' })
          .where(eq(creditApplications.id, row.id));
        await tx.insert(creditApplicationStatusChanges).values({
          creditApplicationId: row.id,
          fromStatus: row.status,
          toStatus: 'expired',
          actorAccountId: null,
          note: 'incomplete_expiry_days',
        });
        await this.audit.record(
          {
            actor: SWEEPER,
            action: 'credit.application_status_changed',
            entityType: 'credit_application',
            entityId: row.id,
            before: { status: row.status },
            after: { status: 'expired' },
          },
          tx,
        );
        await this.publish(tx, 'credit.expired', row);
      },
    );
    return { slaBreached, expired };
  }

  private async each(
    where: ReturnType<typeof and>,
    work: (
      tx: Parameters<Parameters<Database['transaction']>[0]>[0],
      row: ApplicationRow,
    ) => Promise<void>,
  ): Promise<number> {
    let done = 0;
    for (;;) {
      const n = await this.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(creditApplications)
          .where(where)
          .orderBy(asc(creditApplications.createdAt))
          .limit(BATCH)
          .for('update', { skipLocked: true });
        for (const row of rows) await work(tx, row);
        return rows.length;
      });
      done += n;
      if (n < BATCH) return done;
    }
  }

  private async publish(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    type: string,
    row: ApplicationRow,
  ) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'credit_application',
        aggregateId: row.id,
        payload: { creditApplicationId: row.id, caseId: row.caseId, proformaId: row.proformaId },
      },
      tx,
    );
  }
}
