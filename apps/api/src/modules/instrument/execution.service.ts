import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  gregorianDay,
  toJalali,
  type BounceReason,
  type ExecutionStatus,
  type ExecutionAlert,
  type ExecutionView,
  type PermissionCode,
  type ReleaseDueRow,
  type ReleaseRequestOutcome,
  type ReleaseRequestView,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import {
  COLLECTION_ESCALATION,
  type CollectionEscalation,
} from '../../common/collection/collection-escalation.port';
import { ADMIN_NOTICES, type AdminNotices } from '../../common/config/admin-notices.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import type { InstrumentLegal } from '../../common/instrument/instrument-legal.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  NOTIFICATIONS,
  type NotificationsPort,
} from '../../common/notification/notifications.port';
import {
  BORROWER_SMS_HOLD,
  type BorrowerSmsHold,
} from '../../common/repayment/borrower-sms-hold.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

const PROPOSE: PermissionCode = 'instrument.propose_execution';
const APPROVE_COLLECTION: PermissionCode = 'instrument.approve_execution_collection';
const APPROVE_FINANCE: PermissionCode = 'instrument.approve_execution_finance';
const OUTCOME: PermissionCode = 'instrument.record_outcome';
const RELEASE: PermissionCode = 'instrument.approve_release';
const REQUEST_RELEASE: PermissionCode = 'instrument.request_release';
/** One open notice each (a notice code is lowercase letters, digits and underscores). */
const EXCEEDS_NOTICE = {
  collection: 'instrument_clearance_exceeds_collection',
  finance: 'instrument_clearance_exceeds_finance',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (c: string) =>
  sql.raw(`to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const notFound = () => new NotFoundException({ error: 'execution_not_found' });
const instrumentNotFound = () => new NotFoundException({ error: 'instrument_not_found' });

const need = (access: EffectiveAccess, ...any: PermissionCode[]) => {
  if (!any.some((p) => access.permissions.has(p))) {
    throw new ForbiddenException({ error: 'permission_required', permission: any[0] });
  }
};

interface InstrumentRow {
  id: string;
  credit_application_id: string;
  delivery_id: string | null;
  kind: 'cheque' | 'promissory_note';
  role: 'borrower' | 'guarantor';
  issuer_person_id: string;
  amount_rial: string;
  due_on: string | null;
  number_last4: string;
  status: string;
}

interface ExecutionRow {
  id: string;
  instrument_id: string;
  case_id: string;
  schedule_id: string;
  amount_rial: string;
  status: ExecutionStatus;
  proposed_by: string;
  proposal_reason: string;
  proposed_at: string;
  collection_approved_by: string | null;
  finance_approved_by: string | null;
  reject_reason: string | null;
  outcome_on: string | null;
  bounce_reason: BounceReason | null;
  payment_id: string | null;
  kind: 'cheque' | 'promissory_note';
  number_last4: string;
  due_on: string | null;
  issuer_person_id: string;
}

/**
 * Executing a guarantee instrument and releasing it (task 6-8 [مالی]; doc 15 §6; owner
 * 1405/07/16):
 *
 * - a cheque of an overdue loan, due, never larger than what the loan still owes, proposed by
 *   the collection agent and approved by the collection manager and by finance: three
 *   different people (also a CHECK); then presented;
 * - cleared: its money enters through 6-2's own receipt and allocation (the bank_statement
 *   channel), in the same transaction; nothing else posts. Larger than what is owed by then:
 *   refused, the cheque stays presented, the collection manager and finance are alerted
 *   (owner; 6.10). Never anything to suspense;
 * - bounced: stage 4 of the collection unit (a legal referral, decided by its manager), and
 *   with that decision the cheque goes to legal action. A promissory note is referred only;
 * - released by accounting once the loan is fully settled: a live queue, no table of tasks.
 *
 * The ledger, the purse and the installments are reached only through their ports; an
 * instrument's number never leaves here but as its last four characters.
 */
@Injectable()
export class InstrumentExecutionService implements InstrumentLegal {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    // Other modules' ports, resolved when used (the worker provides some itself).
    private readonly moduleRef: ModuleRef,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  private get repayment(): RepaymentPort {
    return this.moduleRef.get<RepaymentPort>(REPAYMENT, { strict: false });
  }

  private get wallet(): WalletPort {
    return this.moduleRef.get<WalletPort>(WALLET, { strict: false });
  }

  private get leads(): LeadCases {
    return this.moduleRef.get<LeadCases>(LEAD_CASES, { strict: false });
  }

  private get notifications(): NotificationsPort {
    return this.moduleRef.get<NotificationsPort>(NOTIFICATIONS, { strict: false });
  }

  private get hold(): BorrowerSmsHold {
    return this.moduleRef.get<BorrowerSmsHold>(BORROWER_SMS_HOLD, { strict: false });
  }

  private get escalation(): CollectionEscalation {
    return this.moduleRef.get<CollectionEscalation>(COLLECTION_ESCALATION, { strict: false });
  }

  private get notices(): AdminNotices {
    return this.moduleRef.get<AdminNotices>(ADMIN_NOTICES, { strict: false });
  }

  // --- execution --------------------------------------------------------------------------

  async propose(
    actor: Actor,
    access: EffectiveAccess,
    input: { instrumentId: string; reason: string },
    now = new Date(),
  ): Promise<ExecutionView> {
    need(access, PROPOSE);
    this.reach(access);
    // ADR-052: who proposes presenting a cheque signs it with their own SMS code.
    const cheque = await this.instrument(this.db, input.instrumentId);
    await this.stepUp.assert(actor, {
      type: 'instrument_execution',
      id: input.instrumentId,
      amountRial: BigInt(cheque.amount_rial),
      step: 'request',
    });
    if (!actor.accountId) throw new ForbiddenException({ error: 'staff_only' });
    const id = await this.db.transaction(async (tx) => {
      const i = await this.instrument(tx, input.instrumentId, true);
      // Owner (۵): a promissory note is only referred to legal, never presented.
      if (i.kind !== 'cheque') throw new ConflictException({ error: 'promissory_legal_only' });
      if (i.status !== 'held')
        throw new ConflictException({ error: 'instrument_not_held', status: i.status });
      const today = gregorianDay(toJalali(now));
      if (i.due_on && i.due_on > today) throw new ConflictException({ error: 'not_due' });
      const loan = await this.loanOf(i.credit_application_id, tx);
      const minDays = (await this.config.resolve('instrument.execution_min_days_past_due', {}, now))
        .value;
      const overdue = (await this.repayment.overdueCases(now, tx)).find(
        (o) => o.caseId === loan.caseId,
      );
      if (!overdue || overdue.maxDaysPastDue < Math.max(1, minDays)) {
        throw new ConflictException({ error: 'not_overdue' });
      }
      await this.checkOwed(loan.scheduleId, BigInt(i.amount_rial), now, tx);
      const made = await tx.execute(sql`
        INSERT INTO instrument_executions (instrument_id, case_id, schedule_id, amount_rial,
                                           proposed_by, proposal_reason)
        VALUES (${i.id}, ${loan.caseId}, ${loan.scheduleId}, ${i.amount_rial}::bigint,
                ${actor.accountId}, ${input.reason})
        ON CONFLICT (instrument_id) WHERE status IN ('proposed', 'presented') DO NOTHING
        RETURNING id
      `);
      const execution = made.rows[0]?.['id'] as string | undefined;
      if (!execution) throw new ConflictException({ error: 'execution_open' });
      await this.audit.record(
        {
          actor,
          action: 'instrument.execution_proposed',
          entityType: 'instrument_execution',
          entityId: execution,
          after: {
            instrumentId: i.id,
            caseId: loan.caseId,
            amountRial: i.amount_rial,
            last4: i.number_last4,
          },
          reason: input.reason,
        },
        tx,
      );
      return execution;
    });
    return this.view(await this.execution(this.db, id));
  }

  /**
   * The collection manager's or finance's approval, in either order; never the proposer's,
   * never one person's twice (owner ۳). With the second the cheque is presented. What is owed
   * is checked again: never larger than it (owner ۴).
   */
  async approve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { as?: 'collection' | 'finance' | undefined },
    now = new Date(),
  ): Promise<ExecutionView> {
    need(access, APPROVE_COLLECTION, APPROVE_FINANCE);
    this.reach(access);
    const canCollection = access.permissions.has(APPROVE_COLLECTION);
    const canFinance = access.permissions.has(APPROVE_FINANCE);
    const as =
      input.as ?? (canCollection && canFinance ? null : canCollection ? 'collection' : 'finance');
    if (as === null) throw new ConflictException({ error: 'approval_role_required' });
    // ADR-052: each approver (collection, then finance) signs with their own SMS code.
    await this.stepUp.assert(actor, {
      type: 'instrument_execution',
      id,
      amountRial: null,
      step: 'approve',
    });
    if (as === 'collection' && !canCollection) {
      throw new ForbiddenException({
        error: 'permission_required',
        permission: APPROVE_COLLECTION,
      });
    }
    if (as === 'finance' && !canFinance) {
      throw new ForbiddenException({ error: 'permission_required', permission: APPROVE_FINANCE });
    }
    await this.db.transaction(async (tx) => {
      const e = await this.execution(tx, id, true);
      if (e.status !== 'proposed') throw new ConflictException({ error: 'execution_not_proposed' });
      const signed = [e.proposed_by, e.collection_approved_by, e.finance_approved_by];
      if (signed.includes(actor.accountId)) throw new ConflictException({ error: 'same_person' });
      if ((as === 'collection' ? e.collection_approved_by : e.finance_approved_by) !== null) {
        throw new ConflictException({ error: 'already_approved', as });
      }
      await this.checkOwed(e.schedule_id, BigInt(e.amount_rial), now, tx);
      const other = as === 'collection' ? e.finance_approved_by : e.collection_approved_by;
      const presented = other !== null;
      await tx.execute(
        as === 'collection'
          ? sql`UPDATE instrument_executions
                SET collection_approved_by = ${actor.accountId}, collection_approved_at = ${now},
                    status = ${presented ? 'presented' : 'proposed'}
                WHERE id = ${id}`
          : sql`UPDATE instrument_executions
                SET finance_approved_by = ${actor.accountId}, finance_approved_at = ${now},
                    status = ${presented ? 'presented' : 'proposed'}
                WHERE id = ${id}`,
      );
      if (presented) {
        await this.moveInstrument(tx, e.instrument_id, 'held', 'presented');
        await this.outbox.publish(
          {
            type: 'instrument.presented',
            aggregateType: 'instrument',
            aggregateId: e.instrument_id,
            payload: {
              instrumentId: e.instrument_id,
              executionId: id,
              caseId: e.case_id,
              amountRial: e.amount_rial,
            },
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actor,
          action: `instrument.execution_approved_${as}`,
          entityType: 'instrument_execution',
          entityId: id,
          before: { status: 'proposed' },
          after: { status: presented ? 'presented' : 'proposed', as },
        },
        tx,
      );
    });
    return this.view(await this.execution(this.db, id));
  }

  async reject(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    need(access, APPROVE_COLLECTION, APPROVE_FINANCE);
    this.reach(access);
    await this.db.transaction(async (tx) => {
      const e = await this.execution(tx, id, true);
      if (e.status !== 'proposed') throw new ConflictException({ error: 'execution_not_proposed' });
      if (e.proposed_by === actor.accountId) throw new ConflictException({ error: 'same_person' });
      await tx.execute(sql`
        UPDATE instrument_executions
        SET status = 'rejected', rejected_by = ${actor.accountId}, reject_reason = ${reason}
        WHERE id = ${id}
      `);
      await this.audit.record(
        {
          actor,
          action: 'instrument.execution_rejected',
          entityType: 'instrument_execution',
          entityId: id,
          before: { status: 'proposed' },
          after: { status: 'rejected' },
          reason,
        },
        tx,
      );
    });
    return this.view(await this.execution(this.db, id));
  }

  /**
   * The bank paid it: through 6-2's receipt (bank_statement channel) and allocation, in this
   * transaction, by the instrument's key. More than the loan still owes: refused, presented
   * still, the collection manager and finance alerted; nothing to suspense (owner; 6.10).
   */
  async cleared(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { clearedOn: string; bankRef: string },
    now = new Date(),
  ): Promise<ExecutionView> {
    need(access, OUTCOME);
    this.reach(access);
    await this.db.transaction(async (tx) => {
      const locked = await this.execution(tx, id, true);
      if (locked.status !== 'presented') {
        throw new ConflictException({ error: 'execution_not_presented' });
      }
      // Checked here, the schedule as it is now: a payment since the approval may have left
      // less owed than the cheque. Refused, presented still; alerts outside this transaction.
      const owed = (await this.repayment.schedule(locked.schedule_id, now, tx)).outstandingRial;
      if (BigInt(locked.amount_rial) > owed) {
        await this.refuseClearance(actor, id, locked.amount_rial, owed, now);
        throw new ConflictException({ error: 'exceeds_outstanding' });
      }
      const payer = (await this.leads.displayNameOf(locked.issuer_person_id, tx)) ?? null;
      const { paymentId } = await this.repayment.registerReceipt(
        actor,
        {
          idempotencyKey: `instrument:${locked.instrument_id}:cleared`,
          scheduleId: locked.schedule_id,
          amountRial: BigInt(locked.amount_rial),
          receivedAt: now,
          // The bank's tracking number: 6-3 matches the bank line to it exactly (labelled a
          // cheque by its key), and 6-2's duplicate warning sees a slip of it entered again.
          reference: input.bankRef,
          channel: 'bank_statement',
          paidOn: input.clearedOn,
          payerName: payer,
        },
        tx,
      );
      await this.repayment.approvePayment(actor, paymentId, tx);
      await tx.execute(sql`
        UPDATE instrument_executions
        SET status = 'cleared', outcome_by = ${actor.accountId}, outcome_on = ${input.clearedOn}::date,
            bank_ref = ${input.bankRef}, payment_id = ${paymentId}
        WHERE id = ${id}
      `);
      await this.moveInstrument(tx, locked.instrument_id, 'presented', 'cleared');
      await this.outbox.publish(
        {
          type: 'instrument.cleared',
          aggregateType: 'instrument',
          aggregateId: locked.instrument_id,
          payload: {
            instrumentId: locked.instrument_id,
            executionId: id,
            caseId: locked.case_id,
            amountRial: locked.amount_rial,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          actor,
          action: 'instrument.execution_cleared',
          entityType: 'instrument_execution',
          entityId: id,
          before: { status: 'presented' },
          after: { status: 'cleared', paymentId, clearedOn: input.clearedOn },
        },
        tx,
      );
    });
    await this.refreshExceedsNotices(now);
    return this.view(await this.execution(this.db, id));
  }

  /** Returned unpaid: recorded, nothing posted; stage 4 of the collection unit (6-7). */
  async bounced(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { bouncedOn: string; reason: BounceReason; note?: string | undefined },
  ): Promise<ExecutionView> {
    need(access, OUTCOME);
    this.reach(access);
    const caseId = await this.db.transaction(async (tx) => {
      const e = await this.execution(tx, id, true);
      if (e.status !== 'presented')
        throw new ConflictException({ error: 'execution_not_presented' });
      await tx.execute(sql`
        UPDATE instrument_executions
        SET status = 'bounced', outcome_by = ${actor.accountId}, outcome_on = ${input.bouncedOn}::date,
            bounce_reason = ${input.reason}, bounce_note = ${input.note ?? null}
        WHERE id = ${id}
      `);
      await this.moveInstrument(tx, e.instrument_id, 'presented', 'bounced');
      await this.outbox.publish(
        {
          type: 'instrument.bounced',
          aggregateType: 'instrument',
          aggregateId: e.instrument_id,
          payload: {
            instrumentId: e.instrument_id,
            executionId: id,
            caseId: e.case_id,
            reason: input.reason,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          actor,
          action: 'instrument.execution_bounced',
          entityType: 'instrument_execution',
          entityId: id,
          before: { status: 'presented' },
          after: { status: 'bounced', reason: input.reason, bouncedOn: input.bouncedOn },
          reason: input.note ?? input.reason,
        },
        tx,
      );
      return e.case_id;
    });
    // After the commit: stage 4's task (a legal referral, proposed and decided in 6-7).
    await this.escalation.chequeBounced(caseId);
    await this.refreshExceedsNotices(new Date());
    return this.view(await this.execution(this.db, id));
  }

  /**
   * INSTRUMENT_LEGAL (6-7's stage 4 decided): the case's bounced cheques go to legal action.
   * A promissory note stays held (owner ۵: only referred, never presented).
   */
  async referToLegal(actor: Actor, caseId: string, tx: SqlExecutor): Promise<number> {
    const moved = await tx.execute(sql`
      UPDATE instruments SET status = 'legal_action'
      WHERE status = 'bounced' AND id IN (
        SELECT instrument_id FROM instrument_executions WHERE case_id = ${caseId} AND status = 'bounced'
      )
      RETURNING id
    `);
    for (const r of moved.rows) {
      await this.audit.record(
        {
          actor,
          action: 'instrument.legal_action',
          entityType: 'instrument',
          entityId: r['id'] as string,
          before: { status: 'bounced' },
          after: { status: 'legal_action', caseId },
        },
        tx,
      );
    }
    return moved.rows.length;
  }

  /**
   * The collection manager's and finance's alert (owner): presented cheques whose clearance is
   * refused, larger than what is owed now. Read only, live; the same as their notices.
   */
  async alerts(access: EffectiveAccess, now = new Date()): Promise<ExecutionAlert[]> {
    need(access, APPROVE_COLLECTION, APPROVE_FINANCE);
    this.reach(access);
    return this.exceeding(now);
  }

  async list(access: EffectiveAccess, status?: ExecutionStatus): Promise<ExecutionView[]> {
    need(access, PROPOSE, APPROVE_COLLECTION, APPROVE_FINANCE, OUTCOME);
    this.reach(access);
    const rows = await this.db.execute(sql`
      ${this.select()}
      WHERE (${status ?? null}::text IS NULL OR e.status = ${status ?? null})
      ORDER BY e.proposed_at DESC, e.id DESC LIMIT 500
    `);
    return (rows.rows as unknown as ExecutionRow[]).map((r) => this.view(r));
  }

  /**
   * Task 6-9: the case's cheques and notes the agent may propose (held), found through the
   * repayment and wallet ports; the last four characters only.
   */
  async candidates(access: EffectiveAccess, caseId: string) {
    need(access, PROPOSE);
    this.reach(access);
    const [scheduleId] = await this.repayment.schedulesOf(caseId);
    if (!scheduleId) return [];
    const purse = await this.wallet.summary((await this.repayment.schedule(scheduleId)).purseId);
    if (!purse.creditApplicationId) return [];
    const rows = await this.db.execute(sql`
      SELECT id, kind, role, number_last4, amount_rial::text AS amount_rial, due_on::text AS due_on
      FROM instruments
      WHERE credit_application_id = ${purse.creditApplicationId} AND status = 'held'
        AND deleted_at IS NULL
      ORDER BY due_on NULLS LAST, id
    `);
    return rows.rows.map((r) => ({
      instrumentId: r['id'] as string,
      kind: r['kind'] as 'cheque' | 'promissory_note',
      role: r['role'] as 'borrower' | 'guarantor',
      numberLast4: r['number_last4'] as string,
      amountRial: r['amount_rial'] as string,
      dueOn: (r['due_on'] as string | null) ?? null,
    }));
  }

  // --- release ------------------------------------------------------------------------------

  /** Accounting's live queue: held instruments of loans with nothing left to pay. */
  async releasesDue(access: EffectiveAccess, now = new Date()): Promise<ReleaseDueRow[]> {
    need(access, RELEASE, REQUEST_RELEASE);
    this.reach(access);
    const held = (
      await this.db.execute(sql`
        SELECT id, credit_application_id, kind, role, number_last4, amount_rial::text AS amount_rial
        FROM instruments WHERE status = 'held' AND deleted_at IS NULL
        ORDER BY credit_application_id, id
      `)
    ).rows;
    const settled = new Map<string, string | null>();
    const out: ReleaseDueRow[] = [];
    for (const r of held) {
      const app = r['credit_application_id'] as string;
      if (!settled.has(app)) settled.set(app, await this.settledCase(app, now));
      const caseId = settled.get(app);
      if (!caseId) continue;
      out.push({
        instrumentId: r['id'] as string,
        caseId,
        kind: r['kind'] as 'cheque' | 'promissory_note',
        role: r['role'] as 'borrower' | 'guarantor',
        numberLast4: r['number_last4'] as string,
        amountRial: r['amount_rial'] as string,
        pendingRequest: await this.pendingRelease(this.db, r['id'] as string),
      });
    }
    return out;
  }

  /**
   * ADR-052 (owner 1405/08/02): a cheque or promissory note goes back only with two people,
   * each signing with their own SMS code. One asks (after full settlement, doc 15 test 12:
   * before it, 409); another approves, and the release is made then, as before; or refuses.
   * The asker may withdraw. The database refuses the asker deciding their own request.
   */
  async requestRelease(
    actor: Actor,
    access: EffectiveAccess,
    instrumentId: string,
    reason: string,
    now = new Date(),
  ): Promise<ReleaseRequestView> {
    need(access, REQUEST_RELEASE);
    this.reach(access);
    const asker = actor.accountId;
    if (!asker) throw new ForbiddenException({ error: 'staff_only' });
    const first = await this.instrument(this.db, instrumentId);
    const caseId = await this.settledCase(first.credit_application_id, now);
    if (!caseId) throw new ConflictException({ error: 'not_settled' });
    if (first.status !== 'held') {
      throw new ConflictException({ error: 'instrument_not_held', status: first.status });
    }
    await this.stepUp.assert(actor, {
      type: 'instrument_release',
      id: instrumentId,
      amountRial: BigInt(first.amount_rial),
      step: 'request',
    });
    return this.db.transaction(async (tx) => {
      const i = await this.instrument(tx, instrumentId, true);
      if (i.status !== 'held')
        throw new ConflictException({ error: 'instrument_not_held', status: i.status });
      if (await this.pendingRelease(tx, i.id)) {
        throw new ConflictException({ error: 'release_requested' });
      }
      const row = (
        await tx.execute(sql`
          INSERT INTO instrument_release_requests (instrument_id, case_id, reason, requested_by)
          VALUES (${i.id}, ${caseId}, ${reason.trim()}, ${asker})
          RETURNING id, ${iso('created_at')} AS created_at
        `)
      ).rows[0] as { id: string; created_at: string } | undefined;
      if (!row) throw new Error('release request insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'instrument.release_requested',
          entityType: 'instrument',
          entityId: i.id,
          after: { requestId: row.id },
          reason: reason.trim(),
        },
        tx,
      );
      return {
        id: row.id,
        instrumentId: i.id,
        caseId,
        reason: reason.trim(),
        requestedBy: asker,
        requestedAt: row.created_at,
      };
    });
  }

  async decideRelease(
    actor: Actor,
    access: EffectiveAccess,
    requestId: string,
    body: { outcome: 'approved' | 'refused'; reason?: string | undefined },
    now = new Date(),
  ): Promise<ReleaseRequestOutcome> {
    need(access, RELEASE);
    this.reach(access);
    if (!actor.accountId) throw new ForbiddenException({ error: 'staff_only' });
    const asked = await this.releaseRequest(this.db, requestId);
    if (asked.requested_by === actor.accountId) {
      throw new ForbiddenException({ error: 'second_person_required' });
    }
    const first = await this.instrument(this.db, asked.instrument_id);
    let caseId: string | null = null;
    if (body.outcome === 'approved') {
      caseId = await this.settledCase(first.credit_application_id, now);
      if (!caseId) throw new ConflictException({ error: 'not_settled' });
      await this.stepUp.assert(actor, {
        type: 'instrument_release',
        id: requestId,
        amountRial: BigInt(first.amount_rial),
        step: 'approve',
      });
    }
    return this.db.transaction(async (tx) => {
      const i = await this.instrument(tx, asked.instrument_id, true);
      const request = await this.releaseRequest(tx, requestId);
      if (request.decided) throw new ConflictException({ error: 'release_request_closed' });
      await tx.execute(sql`
        INSERT INTO instrument_release_decisions (request_id, outcome, decided_by, reason)
        VALUES (${requestId}, ${body.outcome}, ${actor.accountId}, ${body.reason?.trim() ?? null})
      `);
      if (body.outcome === 'refused') {
        await this.audit.record(
          {
            actor,
            action: 'instrument.release_refused',
            entityType: 'instrument',
            entityId: i.id,
            after: { requestId },
            reason: body.reason?.trim() ?? null,
          },
          tx,
        );
        return { requestId, outcome: 'refused' as const, release: null };
      }
      if (i.status !== 'held')
        throw new ConflictException({ error: 'instrument_not_held', status: i.status });
      const release = await this.releaseIn(tx, actor, i, caseId ?? request.case_id);
      return { requestId, outcome: 'approved' as const, release };
    });
  }

  /** The asker takes their request back before anyone decides it. */
  async withdrawRelease(
    actor: Actor,
    access: EffectiveAccess,
    requestId: string,
  ): Promise<ReleaseRequestOutcome> {
    need(access, REQUEST_RELEASE);
    this.reach(access);
    const asked = await this.releaseRequest(this.db, requestId);
    if (asked.requested_by !== actor.accountId) {
      throw new ForbiddenException({ error: 'not_your_request' });
    }
    return this.db.transaction(async (tx) => {
      await this.instrument(tx, asked.instrument_id, true);
      if ((await this.releaseRequest(tx, requestId)).decided) {
        throw new ConflictException({ error: 'release_request_closed' });
      }
      await tx.execute(sql`
        INSERT INTO instrument_release_decisions (request_id, outcome, decided_by)
        VALUES (${requestId}, 'withdrawn', ${actor.accountId})
      `);
      await this.audit.record(
        {
          actor,
          action: 'instrument.release_withdrawn',
          entityType: 'instrument',
          entityId: asked.instrument_id,
          after: { requestId },
        },
        tx,
      );
      return { requestId, outcome: 'withdrawn' as const, release: null };
    });
  }

  /**
   * The release itself (task 6-8), made by the second person: its delivery is released once
   * nothing of it is held any more; its owner is told by SMS to pick it up: their name only.
   */
  private async releaseIn(tx: SqlExecutor, actor: Actor, i: InstrumentRow, caseId: string) {
    if (i.status !== 'held')
      throw new ConflictException({ error: 'instrument_not_held', status: i.status });
    await this.moveInstrument(tx, i.id, 'held', 'released');
    let deliveryReleased = false;
    if (i.delivery_id) {
      const moved = await tx.execute(sql`
        UPDATE physical_deliveries SET status = 'released'
        WHERE id = ${i.delivery_id} AND status = 'archived' AND NOT EXISTS (
          SELECT 1 FROM instruments
          WHERE delivery_id = ${i.delivery_id} AND deleted_at IS NULL
            AND status IN ('received', 'verified', 'held', 'presented')
        )
        RETURNING id
      `);
      deliveryReleased = moved.rows.length > 0;
    }
    let dispatchId: string | null = null;
    const mobile = await this.leads.mobileOf(i.issuer_person_id, tx);
    if (mobile && !(await this.hold.isHeld(i.issuer_person_id, tx))) {
      const name =
        (await this.leads.displayNameOf(i.issuer_person_id, tx)) ??
        (i.role === 'guarantor' ? 'ضامن' : 'مشتری');
      const sent = await this.notifications.send(
        {
          templateCode:
            i.role === 'guarantor'
              ? 'instrument.release_ready_guarantor'
              : 'instrument.release_ready_borrower',
          audience: i.role,
          mobile,
          personId: i.issuer_person_id,
          values: { name },
          idempotencyKey: `instrument:${i.id}:release-ready`,
        },
        tx,
      );
      dispatchId = sent.dispatchId;
    }
    await tx.execute(sql`
      INSERT INTO instrument_releases (instrument_id, case_id, approved_by, sms_dispatch_id)
      VALUES (${i.id}, ${caseId}, ${actor.accountId}, ${dispatchId})
    `);
    await this.outbox.publish(
      {
        type: 'instrument.released',
        aggregateType: 'instrument',
        aggregateId: i.id,
        payload: { instrumentId: i.id, caseId },
      },
      tx,
    );
    await this.audit.record(
      {
        actor,
        action: 'instrument.released',
        entityType: 'instrument',
        entityId: i.id,
        before: { status: 'held' },
        after: { status: 'released', deliveryReleased, smsSent: dispatchId !== null },
      },
      tx,
    );
    return {
      instrumentId: i.id,
      status: 'released' as const,
      deliveryReleased,
      smsSent: dispatchId !== null,
    };
  }

  // --- helpers ----------------------------------------------------------------------------

  /** Staff of the whole network only: a narrower scope finds nothing (rule 13). */
  private reach(access: EffectiveAccess) {
    if (!access.scopes.some((s) => s.kind === 'global')) throw notFound();
  }

  /** The loan of an application: its purse's schedule and case. */
  private async loanOf(creditApplicationId: string, tx?: SqlExecutor) {
    const purseId = await this.wallet.purseOfApplication(creditApplicationId, tx);
    const scheduleId = purseId ? await this.wallet.scheduleOfPurse(purseId, tx) : null;
    if (!purseId || !scheduleId) throw new ConflictException({ error: 'no_loan' });
    const purse = await this.wallet.summary(purseId, tx);
    return { purseId, scheduleId, caseId: purse.caseId };
  }

  /** The case, when its schedule owes nothing more; else null. */
  private async settledCase(creditApplicationId: string, now: Date): Promise<string | null> {
    const purseId = await this.wallet.purseOfApplication(creditApplicationId);
    const scheduleId = purseId ? await this.wallet.scheduleOfPurse(purseId) : null;
    if (!purseId || !scheduleId) return null;
    const schedule = await this.repayment.schedule(scheduleId, now);
    if (schedule.installments.length === 0 || schedule.outstandingRial > 0n) return null;
    return (await this.wallet.summary(purseId)).caseId;
  }

  /**
   * The two notices (the collection manager's, finance's) say which presented cheques are now
   * larger than what their loan owes; resolved once none is. Ids and amounts, no number or
   * name (rule 30). Kept from the data, so one cleared or bounced never hides another.
   */
  private async refreshExceedsNotices(now: Date) {
    const over = (await this.exceeding(now)).map(
      (e) => `${e.executionId} (چک ${e.amountRial}، مانده ${e.owedRial} ریال)`,
    );
    if (over.length === 0) {
      await this.notices.resolve(EXCEEDS_NOTICE.collection, now);
      await this.notices.resolve(EXCEEDS_NOTICE.finance, now);
      return;
    }
    const message = `وصول ${String(over.length)} چک ارائه‌شده رد می‌شود، چون مبلغ چک از مانده بدهی بیشتر است (بی ثبت در معلق؛ تعیین تکلیف: پرسش ۶.۱۰): ${over.join('؛ ')}`;
    await this.notices.raise(EXCEEDS_NOTICE.collection, APPROVE_COLLECTION, message, now);
    await this.notices.raise(EXCEEDS_NOTICE.finance, APPROVE_FINANCE, message, now);
  }

  /** Presented cheques now larger than what their loan owes, live (owner; 6.10). */
  private async exceeding(now: Date): Promise<ExecutionAlert[]> {
    const presented = (
      await this.db.execute(sql`
        SELECT e.id, e.instrument_id, e.case_id, e.schedule_id,
               e.amount_rial::text AS amount_rial, i.number_last4
        FROM instrument_executions e JOIN instruments i ON i.id = e.instrument_id
        WHERE e.status = 'presented' ORDER BY e.proposed_at, e.id
      `)
    ).rows;
    const out: ExecutionAlert[] = [];
    for (const p of presented) {
      const owed = (await this.repayment.schedule(p['schedule_id'] as string, now)).outstandingRial;
      if (BigInt(p['amount_rial'] as string) > owed) {
        out.push({
          executionId: p['id'] as string,
          instrumentId: p['instrument_id'] as string,
          caseId: p['case_id'] as string,
          numberLast4: p['number_last4'] as string,
          amountRial: p['amount_rial'] as string,
          owedRial: owed.toString(),
        });
      }
    }
    return out;
  }

  /** Owner (۱۴۰۵/۰۷/۱۶): the collection manager and finance alerted; 6.10 decides the money. */
  private async refuseClearance(actor: Actor, id: string, amount: string, owed: bigint, now: Date) {
    await this.refreshExceedsNotices(now);
    await this.audit.record({
      actor,
      action: 'instrument.clearance_refused',
      entityType: 'instrument_execution',
      entityId: id,
      after: { amountRial: amount, owedRial: owed.toString() },
    });
  }

  /** Owner ۴: never more than the loan still owes (no surplus, no suspense). */
  private async checkOwed(scheduleId: string, amount: bigint, now: Date, tx: SqlExecutor) {
    const owed = (await this.repayment.schedule(scheduleId, now, tx)).outstandingRial;
    if (amount > owed) {
      throw new ConflictException({
        error: 'exceeds_outstanding',
        amountRial: amount.toString(),
        owedRial: owed.toString(),
      });
    }
  }

  private async moveInstrument(tx: SqlExecutor, id: string, from: string, to: string) {
    const moved = await tx.execute(sql`
      UPDATE instruments SET status = ${to} WHERE id = ${id} AND status = ${from} RETURNING id
    `);
    if (moved.rows.length === 0) throw new ConflictException({ error: 'instrument_moved' });
  }

  private async releaseRequest(ex: SqlExecutor, id: string) {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'release_request_not_found' });
    const row = (
      await ex.execute(sql`
        SELECT r.id, r.instrument_id, r.case_id, r.requested_by,
               EXISTS (SELECT 1 FROM instrument_release_decisions d WHERE d.request_id = r.id)
                 AS decided
        FROM instrument_release_requests r WHERE r.id = ${id}
      `)
    ).rows[0] as
      | {
          id: string;
          instrument_id: string;
          case_id: string;
          requested_by: string;
          decided: boolean;
        }
      | undefined;
    if (!row) throw new NotFoundException({ error: 'release_request_not_found' });
    return row;
  }

  /** The instrument's release asked for and not yet decided, if any. */
  private async pendingRelease(ex: SqlExecutor, instrumentId: string) {
    const row = (
      await ex.execute(sql`
        SELECT r.id, r.requested_by, r.reason, ${iso('r.created_at')} AS created_at
        FROM instrument_release_requests r
        WHERE r.instrument_id = ${instrumentId}
          AND NOT EXISTS (SELECT 1 FROM instrument_release_decisions d WHERE d.request_id = r.id)
        ORDER BY r.created_at DESC LIMIT 1
      `)
    ).rows[0] as
      { id: string; requested_by: string; reason: string; created_at: string } | undefined;
    return row
      ? {
          id: row.id,
          requestedBy: row.requested_by,
          reason: row.reason,
          requestedAt: row.created_at,
        }
      : null;
  }

  private async instrument(ex: SqlExecutor, id: string, lock = false): Promise<InstrumentRow> {
    if (!UUID.test(id)) throw instrumentNotFound();
    const row = (
      await ex.execute(sql`
        SELECT id, credit_application_id, delivery_id, kind, role, issuer_person_id,
               amount_rial::text AS amount_rial, due_on::text AS due_on, number_last4, status
        FROM instruments WHERE id = ${id} AND deleted_at IS NULL
        ${lock ? sql`FOR UPDATE` : sql``}
      `)
    ).rows[0] as InstrumentRow | undefined;
    if (!row) throw instrumentNotFound();
    return row;
  }

  private select() {
    return sql`
      SELECT e.id, e.instrument_id, e.case_id, e.schedule_id, e.amount_rial::text AS amount_rial,
             e.status, e.proposed_by, e.proposal_reason, ${iso('e.proposed_at')} AS proposed_at,
             e.collection_approved_by, e.finance_approved_by, e.reject_reason,
             e.outcome_on::text AS outcome_on, e.bounce_reason, e.payment_id,
             i.kind, i.number_last4, i.due_on::text AS due_on, i.issuer_person_id
      FROM instrument_executions e JOIN instruments i ON i.id = e.instrument_id
    `;
  }

  private async execution(ex: SqlExecutor, id: string, lock = false): Promise<ExecutionRow> {
    if (!UUID.test(id)) throw notFound();
    const row = (
      await ex.execute(
        sql`${this.select()} WHERE e.id = ${id} ${lock ? sql`FOR UPDATE OF e` : sql``}`,
      )
    ).rows[0] as ExecutionRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  private view(r: ExecutionRow): ExecutionView {
    return {
      id: r.id,
      instrumentId: r.instrument_id,
      caseId: r.case_id,
      kind: r.kind,
      numberLast4: r.number_last4,
      amountRial: r.amount_rial,
      dueOn: r.due_on,
      status: r.status,
      proposedBy: r.proposed_by,
      proposalReason: r.proposal_reason,
      proposedAt: r.proposed_at,
      collectionApprovedBy: r.collection_approved_by,
      financeApprovedBy: r.finance_approved_by,
      rejectReason: r.reject_reason,
      outcomeOn: r.outcome_on,
      bounceReason: r.bounce_reason,
      paymentId: r.payment_id,
    };
  }
}
