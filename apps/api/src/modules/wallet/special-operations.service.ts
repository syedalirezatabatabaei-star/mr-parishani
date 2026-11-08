import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { gregorianDay, normalizePersianText, toJalali } from '@sepehr/contracts';
import type {
  DoctorCandidate,
  PermissionCode,
  RequestSpecialOperation,
  SpecialOperationKind,
  SpecialOperationStatus,
  SpecialOperationView,
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
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import { SERVICE_CONTROL, type ServiceControl } from '../../common/service/service-control.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import { purseScopeOf } from '../../common/credit/credit-funding-facts.port';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { lockRefundAccount } from '../../common/ledger/refund-account-lock';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  COMPLETION_REFUNDS,
  type CompletionRefundsPort,
} from '../../common/contract/completion-refunds.port';
import { CONTRACT_TERMS, type ContractTermsPort } from '../../common/contract/contract-terms.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'special_operation_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

/** What each kind is called once done (doc 12 §8). */
const EVENT_OF: Record<SpecialOperationKind, string> = {
  cancel_unused: 'wallet.unused_cancelled',
  reverse_cancel_unused: 'wallet.unused_cancellation_reversed',
  change_doctor: 'wallet.doctor_changed',
  cancel_after_funding: 'wallet.cancelled_after_funding',
};

/** The wallet and schedule keys of one request (rule 5): `purse-op:{id}:{step}`. */
export const purseOpKey = (requestId: string, step: string) => `purse-op:${requestId}:${step}`;

/** A cancellation's, or a doctor change's, outcome. */
interface Result {
  amountRial?: string;
  loanRial?: string;
  downPaymentRial?: string;
  operationId?: string;
  revisionId?: string | null;
  versionId?: string;
  cancelledAuthorizations?: number;
  feeWaivedRial?: string;
  feeRevisionId?: string | null;
  /** ADR-045: the unearned part of a plan fee paid in cash, owed back. */
  planFeeRefundRial?: string;
  planFeeRefundJournalId?: string | null;
  penaltyRial?: string;
  penaltyRateBps?: number;
  penaltyDueOn?: string | null;
  chargeId?: string | null;
  closed?: boolean;
}

/** Who asks and who decides, by kind (owner پ۳: a doctor change by the credit units). */
const ASK: Record<SpecialOperationKind, PermissionCode> = {
  cancel_unused: 'wallet.request_special_operation',
  reverse_cancel_unused: 'wallet.request_special_operation',
  change_doctor: 'wallet.request_doctor_change',
  cancel_after_funding: 'wallet.request_special_operation',
};
const DECIDE: Record<SpecialOperationKind, PermissionCode> = {
  cancel_unused: 'wallet.approve_special_operation',
  reverse_cancel_unused: 'wallet.approve_special_operation',
  change_doctor: 'wallet.approve_doctor_change',
  cancel_after_funding: 'wallet.approve_special_operation',
};

interface RequestRow extends Record<string, unknown> {
  id: string;
  purse_id: string;
  kind: SpecialOperationKind;
  payload: { amountRial?: string; requestId?: string; workplaceId?: string };
  reason: string;
  status: SpecialOperationStatus;
  requested_by: string;
  requested_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  result: Result | null;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS = sql.raw(`id, purse_id, kind, payload, reason, status, requested_by,
  ${iso('requested_at')}, ${iso('decided_at')}, decision_reason, result`);

/**
 * Special operations on a credit purse (doc 12 §7; task 4-8 [financial]; owner 1405/07/13).
 * Asked by one person in finance and approved by another (a CHECK, and here), in one
 * transaction locking the request, then the purse, then the schedule (always this order):
 *
 * - cancel_unused: what is unused, all or `amountRial`, at most what is unused (owner الف);
 *   split by ADR-034's order (owner پ۱: the loan's part first); the loan's part off the
 *   schedule's last untouched installments by a new revision (owner ب, ج, پ۶, پ۷) and off
 *   borrower.debt, the down payment's to downpayment.refund_payable (ADR-036);
 * - reverse_cancel_unused: such a cancellation's full opposite document, and a revision
 *   putting the installments back (owner ج: corrections by reversal only).
 *
 * Every step through phase 1's WALLET and REPAYMENT ports, keyed `purse-op:{id}:{step}`.
 */
@Injectable()
export class SpecialOperationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(REPAYMENT) private readonly repayment: RepaymentPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly facts: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Inject(SERVICE_CONTROL) private readonly services: ServiceControl,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(CONTRACT_TERMS) private readonly contractTerms: ContractTermsPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(COMPLETION_REFUNDS) private readonly refunds: CompletionRefundsPort,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  // --- asking --------------------------------------------------------------------------

  async request(
    actor: Actor,
    access: EffectiveAccess,
    input: RequestSpecialOperation,
  ): Promise<SpecialOperationView> {
    this.require(access, ASK[input.kind]);
    let purseId: string;
    let payload: Record<string, string>;
    if (
      input.kind === 'cancel_unused' ||
      input.kind === 'change_doctor' ||
      input.kind === 'cancel_after_funding'
    ) {
      purseId = input.purseId;
      payload =
        input.kind === 'change_doctor'
          ? { workplaceId: input.workplaceId }
          : input.kind === 'cancel_after_funding'
            ? {}
            : input.amountRial
              ? { amountRial: input.amountRial }
              : {};
      const purse = await this.purse(this.db, purseId);
      if (purse.status !== 'funded') throw conflict('purse_not_funded', { status: purse.status });
    } else {
      const target = await this.find(this.db, input.requestId);
      if (target.kind !== 'cancel_unused' || target.status !== 'approved') {
        throw conflict('not_a_done_cancellation');
      }
      purseId = target.purse_id;
      payload = { requestId: target.id };
    }
    await this.reachable(access, purseId);
    // ADR-052: the asker's own SMS code for this operation on this purse.
    await this.stepUp.assert(actor, {
      type: input.kind === 'change_doctor' ? 'doctor_change' : 'special_operation',
      id: purseId,
      amountRial: payload['amountRial'] ? BigInt(payload['amountRial']) : null,
      step: 'request',
    });
    const row = await this.db
      .transaction(async (tx) => {
        const made = await tx.execute(sql`
          INSERT INTO purse_operation_requests (purse_id, kind, payload, reason, requested_by)
          VALUES (${purseId}, ${input.kind}, ${JSON.stringify(payload)}::jsonb, ${input.reason},
                  ${actor.accountId})
          RETURNING ${COLUMNS}
        `);
        const created = made.rows[0] as RequestRow;
        await this.audit.record(
          {
            actor,
            action: 'wallet.special_operation_requested',
            entityType: 'purse_operation_request',
            entityId: created.id,
            after: { purseId, kind: input.kind, ...payload },
            reason: input.reason,
          },
          tx,
        );
        await this.publish(tx, 'wallet.special_operation_requested', created);
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw conflict('request_open');
        throw error;
      });
    return this.view(row, actor.accountId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: { purseId?: string | undefined; status?: SpecialOperationStatus | undefined },
  ): Promise<SpecialOperationView[]> {
    if (![...Object.values(ASK), ...Object.values(DECIDE)].some((p) => access.permissions.has(p))) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM purse_operation_requests
      WHERE (${query.purseId ?? null}::uuid IS NULL OR purse_id = ${query.purseId ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY requested_at DESC LIMIT 500
    `);
    const out: SpecialOperationView[] = [];
    for (const r of rows.rows as RequestRow[]) {
      const ok = await this.reachable(access, r.purse_id).then(
        () => true,
        () => false,
      );
      if (ok) out.push(this.view(r, actor.accountId));
    }
    return out;
  }

  /**
   * The doctors this purse may move to (f7, owner 1405/07/23, plan 2), for the picker:
   * what changeDoctor would accept (an active center or a private practice, the purse's
   * treatment field, not its doctor), in the current doctor's city. Asked by whoever may ask
   * a doctor change, on a purse they reach. A read in a READ ONLY transaction: nothing can
   * be written, not even an account opened.
   *
   * The doctor's name is treatment data (doc 04 §4): `doctorName` reaches only a holder of
   * access.view_treatment (the field filter strips it), and only they find by it.
   */
  async doctorCandidates(
    access: EffectiveAccess,
    purseId: string,
    q: string | undefined,
  ): Promise<DoctorCandidate[]> {
    this.require(access, ASK.change_doctor);
    await this.reachable(access, purseId);
    const term = q ? normalizePersianText(q) : '';
    return this.db.transaction(
      async (tx) => {
        const purse = await this.wallet.scopeOf(purseId, tx);
        if (!purse) throw new NotFoundException({ error: 'purse_not_found' });
        if (purse.status !== 'funded') {
          throw conflict('purse_not_funded', { status: purse.status });
        }
        const { scope } = purse;
        const current = await this.workplaces.workplaceByNode(scope.doctorNodeId, tx);
        if (!current) return [];
        return this.workplaces.changeCandidates(
          {
            fieldCode: scope.treatmentFieldCode,
            cityCode: current.cityCode,
            excludeNodeId: scope.doctorNodeId,
            term: term === '' ? null : term,
            matchDoctorName: access.permissions.has('access.view_treatment'),
            limit: 20,
          },
          tx,
        );
      },
      { accessMode: 'read only' },
    );
  }

  // --- deciding ------------------------------------------------------------------------

  async approve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<SpecialOperationView> {
    if (!UUID.test(id)) throw notFound();
    const reached = await this.find(this.db, id);
    this.require(access, DECIDE[reached.kind]);
    await this.reachable(access, reached.purse_id);
    // ADR-052: the approver's own SMS code for this request and its amount.
    await this.stepUp.assert(actor, {
      type: reached.kind === 'change_doctor' ? 'doctor_change' : 'special_operation',
      id,
      amountRial: reached.payload.amountRial ? BigInt(reached.payload.amountRial) : null,
      step: 'approve',
    });
    const row = await this.db.transaction(async (tx) => {
      const request = await this.lock(tx, id);
      // Approving twice changes nothing (rule 5).
      if (request.status === 'approved') return request;
      if (request.status !== 'requested') throw conflict('request_decided');
      // Doc 12 §7: two people for anything that moves money.
      if (request.requested_by === actor.accountId) throw conflict('same_person');
      const purse = await this.purse(tx, request.purse_id, true);
      const why = `${request.reason} — ${reason}`;
      const result =
        request.kind === 'cancel_unused'
          ? await this.cancel(actor, tx, request, purse.status, why)
          : request.kind === 'change_doctor'
            ? await this.changeDoctor(actor, tx, request, why)
            : request.kind === 'cancel_after_funding'
              ? await this.cancelAfterFunding(actor, tx, request, purse.status, why)
              : await this.reverse(actor, tx, request, why);
      const done = await tx.execute(sql`
        UPDATE purse_operation_requests
        SET status = 'approved', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason}, result = ${JSON.stringify(result)}::jsonb
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const approved = done.rows[0] as RequestRow;
      await this.audit.record(
        {
          actor,
          action: EVENT_OF[request.kind],
          entityType: 'purse_operation_request',
          entityId: id,
          before: { status: 'requested' },
          after: { status: 'approved', ...result },
          reason,
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: EVENT_OF[request.kind],
          aggregateType: 'purse_operation_request',
          aggregateId: id,
          payload:
            request.kind === 'cancel_after_funding'
              ? {
                  requestId: id,
                  purseId: request.purse_id,
                  kind: request.kind,
                  feeWaivedRial: result.feeWaivedRial ?? '0',
                  planFeeRefundRial: result.planFeeRefundRial ?? '0',
                  penaltyRial: result.penaltyRial ?? '0',
                }
              : request.kind === 'change_doctor'
                ? {
                    requestId: id,
                    purseId: request.purse_id,
                    kind: request.kind,
                    workplaceId: request.payload.workplaceId,
                  }
                : request.kind === 'cancel_unused'
                  ? {
                      requestId: id,
                      purseId: request.purse_id,
                      kind: request.kind,
                      amountRial: result.amountRial,
                      loanRial: result.loanRial,
                      downPaymentRial: result.downPaymentRial,
                    }
                  : {
                      requestId: id,
                      purseId: request.purse_id,
                      kind: request.kind,
                      reversesRequestId: request.payload.requestId,
                    },
        },
        tx,
      );
      return approved;
    });
    return this.view(row, actor.accountId);
  }

  async reject(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<SpecialOperationView> {
    if (!UUID.test(id)) throw notFound();
    const reached = await this.find(this.db, id);
    this.require(access, DECIDE[reached.kind]);
    await this.reachable(access, reached.purse_id);
    const row = await this.db.transaction(async (tx) => {
      const request = await this.lock(tx, id);
      if (request.status !== 'requested') throw conflict('request_decided');
      if (request.requested_by === actor.accountId) throw conflict('same_person');
      const done = await tx.execute(sql`
        UPDATE purse_operation_requests
        SET status = 'rejected', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const rejected = done.rows[0] as RequestRow;
      await this.audit.record(
        {
          actor,
          action: 'wallet.special_operation_rejected',
          entityType: 'purse_operation_request',
          entityId: id,
          before: { status: 'requested' },
          after: { status: 'rejected' },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'wallet.special_operation_rejected', rejected);
      return rejected;
    });
    return this.view(row, actor.accountId);
  }

  // --- the operations ------------------------------------------------------------------

  private async cancel(
    actor: Actor,
    tx: SqlExecutor,
    request: RequestRow,
    status: string,
    reason: string,
  ): Promise<Result> {
    if (status !== 'funded') throw conflict('purse_not_funded', { status });
    const unused = await this.wallet.unusedOf(request.purse_id, tx);
    const available = unused.loanRial + unused.downPaymentRial;
    const amount =
      request.payload.amountRial === undefined ? available : BigInt(request.payload.amountRial);
    // Owner الف: never more than what is unused.
    if (amount <= 0n || amount > available) {
      throw conflict('exceeds_unused', { unusedRial: available.toString() });
    }
    // Owner پ۱: the loan's unused part first, then the down payment's.
    const loan = amount < unused.loanRial ? amount : unused.loanRial;
    const down = amount - loan;
    let revisionId: string | null = null;
    if (loan > 0n) {
      const schedule = await this.scheduleOf(tx, request.purse_id);
      revisionId = (
        await this.repayment.reduceFromLast(
          actor,
          {
            scheduleId: schedule,
            amountRial: loan,
            idempotencyKey: purseOpKey(request.id, 'schedule'),
            reason,
          },
          tx,
        )
      ).revisionId;
    }
    const op = await this.wallet.cancelUnused(
      actor,
      request.purse_id,
      { idempotencyKey: purseOpKey(request.id, 'cancel'), reason, amountRial: amount },
      tx,
    );
    return {
      amountRial: amount.toString(),
      loanRial: loan.toString(),
      downPaymentRial: down.toString(),
      operationId: op.operationId,
      revisionId,
    };
  }

  /**
   * Cancelling after funding (doc 02 §6; task 4-8 part 7; owner 1405/07/14), in this request's
   * transaction, each step keyed `purse-op:{id}:{step}`:
   *   1. open authorizations cancelled; a recorded one not final stops it all (پ۹);
   *   2. whatever is unused cancelled (part 1: the loan's part off the debt and the last
   *      installments, the down payment's to refund);
   *   3. the plan fee of installments not yet due and never paid, waived (پ۱۱ الف, س۱);
   *   3b. a plan fee paid in cash at completion: the shares of the installments not yet due,
   *      owed back to the borrower on their own (ADR-045), never netted with the penalty;
   *   4. the penalty: the rate the contract locked × the approved loan, rounded down to the
   *      rial, a lump sum on its own due day (پ۱۲-ب ج, س۲, س۴); never posted twice;
   *   5. the purse closed only if nothing is left open (س۳), and the case closed when none of
   *      its purses is still open.
   */
  private async cancelAfterFunding(
    actor: Actor,
    tx: SqlExecutor,
    request: RequestRow,
    status: string,
    reason: string,
  ): Promise<Result> {
    if (status !== 'funded') throw conflict('purse_not_funded', { status });
    const now = new Date();
    const today = gregorianDay(toJalali(now));
    // 1.
    const { cancelled } = await this.services.cancelOpen(actor, request.purse_id, reason, tx);
    // 2.
    const unused = await this.wallet.unusedOf(request.purse_id, tx);
    const cancelledPart =
      unused.loanRial + unused.downPaymentRial > 0n
        ? await this.cancel(actor, tx, { ...request, payload: {} }, status, reason)
        : {};
    // 3.
    const scheduleId = await this.scheduleOf(tx, request.purse_id);
    const fee = await this.repayment.waivePlanFee(
      actor,
      { scheduleId, today, idempotencyKey: purseOpKey(request.id, 'fee'), reason },
      tx,
    );
    // 3b. ADR-045: a plan fee paid in cash at completion: its unearned part owed back, on its
    // own document (Dr company.fee_income, Cr fee.refund_payable), never netted with 4.
    const funded = await this.wallet.summary(request.purse_id, tx);
    const installments = (await this.repayment.schedule(scheduleId, now, tx)).installments;
    const cashFee = funded.creditApplicationId
      ? await this.refunds.refundUnearnedPlanFee(
          actor,
          {
            creditApplicationId: funded.creditApplicationId,
            operationId: request.id,
            today,
            installments: installments.map((i) => ({ index: i.index, dueOn: i.dueOn })),
          },
          tx,
        )
      : null;
    // 4.
    const purse = await this.wallet.summary(request.purse_id, tx);
    const terms = purse.creditApplicationId
      ? await this.contractTerms.penaltyOf(purse.creditApplicationId, tx)
      : null;
    if (!terms) throw conflict('no_contract');
    const base = purse.approvedAmountRial;
    const penalty = (base * BigInt(terms.penaltyBps)) / 10_000n;
    let chargeId: string | null = null;
    let dueOn: string | null = null;
    if (penalty > 0n) {
      const days = (await this.config.resolve('repayment.cancellation_penalty_due_days', {}, now))
        .value;
      dueOn = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)
        .toISOString()
        .slice(0, 10);
      chargeId = (
        await this.repayment.addCharge(
          actor,
          {
            scheduleId,
            kind: 'cancellation_penalty',
            amountRial: penalty,
            baseRial: base,
            rateBps: terms.penaltyBps,
            dueOn,
            idempotencyKey: purseOpKey(request.id, 'penalty'),
            reason,
          },
          tx,
        )
      ).chargeId;
    }
    // 5.
    await this.wallet.closeIfSettled(actor, request.purse_id, { reason }, tx);
    const others = await tx.execute(sql`
      SELECT count(*)::int AS n FROM credit_purses
      WHERE case_id = ${purse.caseId} AND id <> ${request.purse_id} AND status <> 'closed'
    `);
    if (Number(others.rows[0]?.['n']) === 0) {
      await this.leads.closeCase(tx, actor, purse.caseId, 'treatment_cancelled', null);
    }
    return {
      ...cancelledPart,
      cancelledAuthorizations: cancelled,
      feeWaivedRial: fee.waivedRial.toString(),
      feeRevisionId: fee.revisionId,
      planFeeRefundRial: cashFee?.amountRial ?? '0',
      planFeeRefundJournalId: cashFee?.journalEntryId ?? null,
      penaltyRial: penalty.toString(),
      penaltyRateBps: terms.penaltyBps,
      penaltyDueOn: dueOn,
      chargeId,
      closed: true,
    };
  }

  /**
   * A new doctor (doc 12 §7, §9 test 12; owner پ۲: no Referral): the same treatment field
   * (else a new credit decision), an active center, open authorizations cancelled (a
   * recorded one not final stops it, پ۹), then the scope's new version. No money moves.
   */
  private async changeDoctor(
    actor: Actor,
    tx: SqlExecutor,
    request: RequestRow,
    reason: string,
  ): Promise<Result> {
    const workplace = await this.workplaces.workplace(request.payload.workplaceId ?? '', tx);
    if (!workplace) throw new NotFoundException({ error: 'workplace_not_found' });
    if (workplace.centerStatus !== null && workplace.centerStatus !== 'active') {
      throw conflict('center_not_active', { status: workplace.centerStatus });
    }
    const current = (await this.wallet.summary(request.purse_id, tx)).scope;
    if (workplace.nodeId === current.doctorNodeId) throw conflict('same_doctor');
    const fields = await this.workplaces.doctorFieldCodes(workplace.id, tx);
    if (!fields.includes(current.treatmentFieldCode)) throw conflict('needs_new_credit_decision');
    const { cancelled } = await this.services.cancelOpen(actor, request.purse_id, reason, tx);
    const { versionId } = await this.wallet.changeScope(
      actor,
      request.purse_id,
      {
        idempotencyKey: purseOpKey(request.id, 'scope'),
        scope: purseScopeOf(workplace, current.treatmentFieldCode),
        reason,
      },
      tx,
    );
    return { versionId, cancelledAuthorizations: cancelled };
  }

  private async reverse(
    actor: Actor,
    tx: SqlExecutor,
    request: RequestRow,
    reason: string,
  ): Promise<Result> {
    const targetId = request.payload.requestId ?? '';
    const target = await this.lock(tx, targetId);
    const done = target.result;
    if (
      target.kind !== 'cancel_unused' ||
      target.status !== 'approved' ||
      !done?.operationId ||
      !done.amountRial ||
      !done.loanRial ||
      !done.downPaymentRial
    ) {
      throw conflict('not_a_done_cancellation');
    }
    // A down payment put to refund may have been paid out since (part 4): the reversal takes
    // it back from the refund account, so that account must still hold it (never below zero).
    const down = BigInt(done.downPaymentRial);
    if (down > 0n) {
      const purse = await this.wallet.summary(request.purse_id, tx);
      const rows = await tx.execute(
        sql`SELECT borrower_person_id FROM credit_purses WHERE id = ${request.purse_id}`,
      );
      const account = {
        entityId: purse.entityId,
        code: 'downpayment.refund_payable' as const,
        borrowerPersonId: rows.rows[0]?.['borrower_person_id'] as string,
      };
      await lockRefundAccount(tx, account);
      const found = await this.ledger.findAccount(
        { ...account, ownerType: 'borrower', ownerId: account.borrowerPersonId },
        tx,
      );
      const b = found ? await this.ledger.balanceOf(found.id, undefined, tx) : null;
      const owed = b ? b.creditRial - b.debitRial : 0n;
      if (owed < down) throw conflict('refund_paid', { owedRial: owed.toString() });
    }
    const op = await this.wallet.reverseOperation(
      actor,
      request.purse_id,
      done.operationId,
      { idempotencyKey: purseOpKey(request.id, 'reverse'), reason },
      tx,
    );
    let revisionId: string | null = null;
    if (done.revisionId) {
      revisionId = (
        await this.repayment.revertRevision(
          actor,
          {
            revisionId: done.revisionId,
            idempotencyKey: purseOpKey(request.id, 'schedule'),
            reason,
          },
          tx,
        )
      ).revisionId;
    }
    return {
      amountRial: done.amountRial,
      loanRial: done.loanRial,
      downPaymentRial: done.downPaymentRial,
      operationId: op.operationId,
      revisionId,
    };
  }

  // --- helpers ---------------------------------------------------------------------------

  private async purse(ex: SqlExecutor, id: string, forUpdate = false) {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'purse_not_found' });
    const rows = await ex.execute(sql`
      SELECT id, status, credit_application_id FROM credit_purses WHERE id = ${id}
      ${forUpdate ? sql`FOR UPDATE` : sql``}
    `);
    const row = rows.rows[0];
    if (!row) throw new NotFoundException({ error: 'purse_not_found' });
    return {
      id: row['id'] as string,
      status: row['status'] as string,
      creditApplicationId: row['credit_application_id'] as string | null,
    };
  }

  /** The purse's schedule, from its funding (task 4-5). */
  private async scheduleOf(ex: SqlExecutor, purseId: string): Promise<string> {
    const rows = await ex.execute(sql`
      SELECT schedule_id FROM funding_requests WHERE purse_id = ${purseId} AND status = 'approved'
    `);
    const id = rows.rows[0]?.['schedule_id'] as string | undefined;
    if (!id) throw conflict('no_schedule');
    return id;
  }

  private async find(ex: SqlExecutor, id: string): Promise<RequestRow> {
    if (!UUID.test(id)) throw notFound();
    const rows = await ex.execute(
      sql`SELECT ${COLUMNS} FROM purse_operation_requests WHERE id = ${id}`,
    );
    const row = rows.rows[0] as RequestRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async lock(ex: SqlExecutor, id: string): Promise<RequestRow> {
    if (!UUID.test(id)) throw notFound();
    const rows = await ex.execute(
      sql`SELECT ${COLUMNS} FROM purse_operation_requests WHERE id = ${id} FOR UPDATE`,
    );
    const row = rows.rows[0] as RequestRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  /** Staff reach a purse whose application is of their city, or any with a global scope. */
  private async reachable(access: EffectiveAccess, purseId: string): Promise<void> {
    if (access.scopes.some((s) => s.kind === 'global')) return;
    const purse = await this.purse(this.db, purseId);
    const facts = purse.creditApplicationId
      ? await this.facts.facts(purse.creditApplicationId)
      : null;
    const proforma = facts ? await this.proformas.proforma(facts.proformaId) : null;
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    if (!proforma || !cities.includes(proforma.cityCode)) {
      throw new NotFoundException({ error: 'purse_not_found' });
    }
  }

  private view(r: RequestRow, viewer: string | null): SpecialOperationView {
    return {
      id: r.id,
      purseId: r.purse_id,
      kind: r.kind,
      status: r.status,
      amountRial: r.payload.amountRial ?? null,
      reversesRequestId: r.payload.requestId ?? null,
      workplaceId: r.payload.workplaceId ?? null,
      reason: r.reason,
      requestedAt: r.requested_at,
      requestedByMe: viewer !== null && r.requested_by === viewer,
      decidedAt: r.decided_at,
      decisionReason: r.decision_reason,
      result: r.result,
    };
  }

  private async publish(tx: SqlExecutor, type: string, row: RequestRow) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'purse_operation_request',
        aggregateId: row.id,
        payload: { requestId: row.id, purseId: row.purse_id, kind: row.kind },
      },
      tx,
    );
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}
