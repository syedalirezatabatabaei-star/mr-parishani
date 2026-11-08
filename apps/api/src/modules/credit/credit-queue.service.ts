import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { CreditQueue } from '@sepehr/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import {
  ASSIGNMENT_ENGINE,
  type AssignmentEngine,
  type AssignmentKey,
} from '../../common/lead/assignment-engine.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import { creditApplicationAssignments, creditApplications } from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ApplicationRow = typeof creditApplications.$inferSelect;

/** The states in which an application is open in each queue (an agent's cap counts these). */
export const QUEUE_OPEN_STATUSES: Readonly<Record<CreditQueue, readonly string[]>> = {
  completion: ['incomplete'],
  credit: ['ready_for_review', 'scoring', 'manual_review'],
  committee: ['manual_review'],
};

/**
 * The credit queues (task 3-5 part D; doc 10 §8): case completion (`incomplete`), credit
 * review (`ready_for_review` to `manual_review`) and the committee. Chosen by the lead
 * module's engine through ASSIGNMENT_ENGINE (doc 05 §6: shares by queue, city and field,
 * presence, caps, never copied), recorded here; by hand only with a reason.
 */
@Injectable()
export class CreditQueueService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(ASSIGNMENT_ENGINE) private readonly engine: AssignmentEngine,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
  ) {}

  /** The application's key to the shares: its proforma's city and its case's field. */
  async keyFor(app: ApplicationRow, queueCode: CreditQueue): Promise<AssignmentKey> {
    const [proforma, facts] = await Promise.all([
      this.proformas.proforma(app.proformaId),
      this.leads.caseFacts(app.caseId),
    ]);
    return {
      queueCode,
      cityCode: proforma?.cityCode ?? null,
      treatmentFieldCode: facts?.treatmentFieldCode ?? null,
    };
  }

  /** In the caller's transaction: who takes it, recorded; unassigned when nobody can. */
  async assign(
    tx: Tx,
    actor: Actor,
    app: ApplicationRow,
    key: AssignmentKey & { queueCode: CreditQueue },
  ) {
    const pick = await this.engine.pick(tx, key, (ids) => this.openCounts(tx, key.queueCode, ids));
    await tx.insert(creditApplicationAssignments).values({
      creditApplicationId: app.id,
      queueCode: key.queueCode,
      accountId: pick?.accountId ?? null,
      kind: pick ? 'auto' : 'unassigned',
      weightVersionId: pick?.weightVersionId ?? null,
      createdBy: actor.accountId,
    });
    await this.publish(
      tx,
      app,
      key.queueCode,
      pick ? { accountId: pick.accountId, kind: 'auto' } : null,
    );
    return pick;
  }

  /** By hand, with a reason (doc 05 §6), to a staff account; audited. */
  async assignManually(
    actor: Actor,
    app: ApplicationRow,
    input: { queueCode: CreditQueue; accountId: string; reason: string },
  ) {
    if (!QUEUE_OPEN_STATUSES[input.queueCode].includes(app.status)) {
      throw new ConflictException({ error: 'not_in_queue', status: app.status });
    }
    const account = await this.accounts.find(input.accountId);
    if (account?.kind !== 'staff' || account.status !== 'active') {
      throw new BadRequestException({ error: 'not_a_staff_account' });
    }
    await this.db.transaction(async (tx) => {
      await tx.insert(creditApplicationAssignments).values({
        creditApplicationId: app.id,
        queueCode: input.queueCode,
        accountId: input.accountId,
        kind: 'manual',
        reason: input.reason,
        createdBy: actor.accountId,
      });
      await this.audit.record(
        {
          actor,
          action: 'credit.assigned_manually',
          entityType: 'credit_application',
          entityId: app.id,
          after: { queueCode: input.queueCode, accountId: input.accountId },
          reason: input.reason,
        },
        tx,
      );
      await this.publish(tx, app, input.queueCode, { accountId: input.accountId, kind: 'manual' });
    });
  }

  /** The applications open in a queue whose current assignee is this account. */
  async assignedTo(accountId: string, queueCode: CreditQueue): Promise<string[]> {
    const result = await this.db.execute(sql`
      SELECT a.id FROM credit_applications a
      JOIN LATERAL (
        SELECT account_id FROM credit_application_assignments s
        WHERE s.credit_application_id = a.id AND s.queue_code = ${queueCode}
        ORDER BY s.created_at DESC, s.id DESC LIMIT 1
      ) cur ON true
      WHERE cur.account_id = ${accountId}::uuid
        AND a.status IN (${sql.join(
          QUEUE_OPEN_STATUSES[queueCode].map((s) => sql`${s}`),
          sql`, `,
        )})
      ORDER BY a.created_at`);
    return result.rows.map((r) => r['id'] as string);
  }

  async history(appId: string) {
    const rows = await this.db
      .select()
      .from(creditApplicationAssignments)
      .where(eq(creditApplicationAssignments.creditApplicationId, appId))
      .orderBy(asc(creditApplicationAssignments.createdAt), asc(creditApplicationAssignments.id));
    return rows.map((r) => ({
      queueCode: r.queueCode,
      accountId: r.accountId,
      kind: r.kind,
      at: r.createdAt.toISOString(),
    }));
  }

  /** Each agent's applications open in this queue whose current assignee they are. */
  private async openCounts(tx: Tx, queueCode: CreditQueue, accountIds: readonly string[]) {
    if (accountIds.length === 0) return new Map<string, number>();
    const result = await tx.execute(sql`
      SELECT cur.account_id, count(*)::int AS n FROM credit_applications a
      JOIN LATERAL (
        SELECT account_id FROM credit_application_assignments s
        WHERE s.credit_application_id = a.id AND s.queue_code = ${queueCode}
        ORDER BY s.created_at DESC, s.id DESC LIMIT 1
      ) cur ON true
      WHERE cur.account_id IN (${sql.join(
        accountIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND a.status IN (${sql.join(
          QUEUE_OPEN_STATUSES[queueCode].map((s) => sql`${s}`),
          sql`, `,
        )})
      GROUP BY cur.account_id`);
    return new Map(result.rows.map((r) => [r['account_id'] as string, Number(r['n'])]));
  }

  private async publish(
    tx: Tx,
    app: ApplicationRow,
    queueCode: CreditQueue,
    who: { accountId: string; kind: 'auto' | 'manual' } | null,
  ) {
    const base = {
      creditApplicationId: app.id,
      caseId: app.caseId,
      proformaId: app.proformaId,
      queueCode,
    };
    await this.outbox.publish(
      who
        ? {
            type: 'credit.assigned',
            aggregateType: 'credit_application',
            aggregateId: app.id,
            payload: { ...base, ...who },
          }
        : {
            type: 'credit.unassigned',
            aggregateType: 'credit_application',
            aggregateId: app.id,
            payload: base,
          },
      tx,
    );
  }
}
