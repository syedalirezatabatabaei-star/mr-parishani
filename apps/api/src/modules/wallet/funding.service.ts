import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  FundingRequestStatus,
  FundingRequestView,
  MyFundingView,
  PermissionCode,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import {
  COMPLETION_STATUS,
  type CompletionStatusPort,
} from '../../common/contract/completion-status.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFacts,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import {
  CREDIT_FUNDING_FACTS,
  type CreditFundingFactsPort,
} from '../../common/credit/credit-funding-facts.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  BORROWER_EXPOSURE,
  BorrowerCapExceeded,
  type BorrowerExposurePort,
} from '../../common/credit/borrower-exposure.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { assertIncomeEntity } from '../../common/ledger/income-entities';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVED = ['approved', 'conditional'];
const notFound = () => new NotFoundException({ error: 'funding_request_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

interface RequestRow extends Record<string, unknown> {
  id: string;
  credit_application_id: string;
  status: FundingRequestStatus;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  purse_id: string | null;
  schedule_id: string | null;
}

/** Timestamps as ISO text, read the same way by every query here. */
const COLUMNS = sql.raw(`id, credit_application_id, status, requested_by,
  to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,
  decided_by,
  to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
  decision_reason, purse_id, schedule_id`);

/** The idempotency key of a funding (doc 12 §5); each step keys its own operation off it. */
export const fundingKey = (creditApplicationId: string) => `fund:${creditApplicationId}`;

/**
 * Funding a credit purse (doc 12 §5; task 4-5 [financial]; ADR-034). Case completion asks;
 * another person in finance approves (maker-checker, owner's decision 7). Approval is one
 * transaction keyed `fund:{credit_application_id}`, through phase 1's services only:
 *
 *   1. completion and the application's status, re-read and locked in this transaction
 *      (owner's requirements 2 and 3: through the contract and credit modules' ports);
 *   2. the down payment's posting (ADR-034), posted now if approved before it;
 *   3. credit approved (Dr borrower.debt A, Dr downpayment.held D, Cr purse.approved A+D);
 *   4. the purse charged (A + D), which fixes funded_at;
 *   5. the plan fee when spread, and the installment schedule from funded_at;
 *   6. the schedule must be the contract's, to the rial, or everything rolls back
 *      (owner's decision 6; the rounding version, launch blocker م۱).
 */
@Injectable()
export class FundingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(REPAYMENT) private readonly repayment: RepaymentPort,
    @Inject(COMPLETION_STATUS) private readonly completion: CompletionStatusPort,
    @Inject(CREDIT_FUNDING_FACTS) private readonly fundingFacts: CreditFundingFactsPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly facts: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(BORROWER_EXPOSURE) private readonly exposure: BorrowerExposurePort,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  // --- asking -------------------------------------------------------------------------

  async request(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
  ): Promise<FundingRequestView> {
    this.require(access, 'wallet.request_funding');
    const facts = await this.reachable(access, creditApplicationId);
    if (!APPROVED.includes(facts.status)) throw conflict('not_approved', { status: facts.status });
    if ((await this.completion.completedAt(creditApplicationId)) === null) {
      throw conflict('not_completed');
    }
    // ADR-052: the asker's own SMS code for this charge, before anything is written.
    await this.stepUp.assert(actor, {
      type: 'funding',
      id: creditApplicationId,
      amountRial: facts.approvedAmountRial,
      step: 'request',
    });
    const row = await this.db
      .transaction(async (tx) => {
        const made = await tx.execute(sql`
          INSERT INTO funding_requests (credit_application_id, requested_by)
          VALUES (${creditApplicationId}, ${actor.accountId})
          RETURNING ${COLUMNS}
        `);
        const created = made.rows[0] as RequestRow;
        await this.audit.record(
          {
            actor,
            action: 'wallet.funding_requested',
            entityType: 'funding_request',
            entityId: created.id,
            after: { creditApplicationId },
          },
          tx,
        );
        await this.publish(tx, 'wallet.funding_requested', created);
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw conflict('funding_exists');
        throw error;
      });
    return this.view(row, facts, actor.accountId);
  }

  async list(
    access: EffectiveAccess,
    accountId: string | null,
    query: { status?: FundingRequestStatus | undefined; creditApplicationId?: string | undefined },
  ): Promise<FundingRequestView[]> {
    if (
      !access.permissions.has('wallet.request_funding') &&
      !access.permissions.has('wallet.approve_funding')
    ) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM funding_requests
      WHERE (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
        AND (${query.creditApplicationId ?? null}::uuid IS NULL
             OR credit_application_id = ${query.creditApplicationId ?? null})
      ORDER BY requested_at
      LIMIT 500
    `);
    const views: FundingRequestView[] = [];
    for (const r of rows.rows as RequestRow[]) {
      const facts = await this.reachable(access, r.credit_application_id).catch(() => null);
      if (facts) views.push(this.view(r, facts, accountId));
    }
    return views;
  }

  // --- deciding -----------------------------------------------------------------------

  async approve(actor: Actor, access: EffectiveAccess, id: string): Promise<FundingRequestView> {
    this.require(access, 'wallet.approve_funding');
    if (!UUID.test(id)) throw notFound();
    const reached = await this.requestRow(this.db, id);
    const target = await this.reachable(access, reached.credit_application_id);
    // ADR-052: the approver's own SMS code for this request and its amount.
    await this.stepUp.assert(actor, {
      type: 'funding',
      id,
      amountRial: target.approvedAmountRial,
      step: 'approve',
    });
    const now = new Date();
    const row = await this.db
      .transaction(async (tx) => {
        // ADR-051: the borrower's row first, then the request and the application (as a decision).
        await this.exposure.lockBorrower(tx, target.borrowerPersonId);
        const request = await this.lockRequest(tx, id);
        // Approving twice changes nothing (rule 5; doc 12 §9 test 3).
        if (request.status === 'approved') return request;
        if (request.status !== 'requested')
          throw conflict('request_decided', { status: request.status });
        // Doc 12 §9 test 2: never one person alone.
        if (request.requested_by === actor.accountId) throw conflict('same_person');
        const appId = request.credit_application_id;

        // 1. As they are now, locked for the rest of this transaction.
        const facts = await this.fundingFacts.lockForFunding(appId, tx);
        if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
        if (!APPROVED.includes(facts.status))
          throw conflict('not_approved', { status: facts.status });
        if (facts.approvedAmountRial === null) throw conflict('not_approved');
        const ready = await this.completion.lockForFunding(actor, appId, tx);
        if (ready.completedAt === null) throw conflict('not_completed');
        if (ready.problem) throw conflict(ready.problem);
        if (ready.entityId === null) throw conflict('no_contract');
        // Income (the spread plan fee) and the down payment belong to Aramesh only (ADR-007).
        assertIncomeEntity(ready.entityId);

        // ADR-051: the borrower's whole active balance, with this loan, within the cap.
        await this.exposure.check(tx, appId, facts.approvedAmountRial, 'funding');

        // 2. The down payment the purse takes in (ADR-034): exactly the one owed.
        const down = facts.downPaymentRial;
        if (down > 0n) {
          if (!ready.downPayment) throw conflict('down_payment_missing');
          if (ready.downPayment.amountRial !== down) {
            throw conflict('down_payment_differs', {
              postedRial: ready.downPayment.amountRial.toString(),
              owedRial: down.toString(),
            });
          }
        }

        // 3–5. Phase 1's services, in this transaction, each with its own key.
        const key = fundingKey(appId);
        const approved = await this.wallet.approveCredit(
          actor,
          {
            idempotencyKey: `${key}:approve`,
            entityId: ready.entityId,
            caseId: facts.caseId,
            creditApplicationId: appId,
            borrowerPersonId: facts.borrowerPersonId,
            amountRial: facts.approvedAmountRial,
            scope: facts.scope,
            ...(down > 0n && ready.downPayment
              ? {
                  downPayment: { amountRial: down, heldAccountId: ready.downPayment.heldAccountId },
                }
              : {}),
          },
          tx,
        );
        const purseId = approved.purseId;
        await this.wallet.charge(actor, purseId, { idempotencyKey: `${key}:charge` }, tx);
        const planFeeRial = facts.planFeeTiming === 'spread' ? facts.planFeeRial : 0n;
        const { scheduleId } = await this.repayment.createSchedule(
          actor,
          {
            idempotencyKey: `${key}:schedule`,
            purseId,
            installmentCount: facts.installmentCount,
            planFeeRial,
            roundingConfigVersionId: facts.roundingVersionId,
            shiftConfigVersionId: facts.shiftVersionId,
            graceConfigVersionId: facts.graceVersionId,
          },
          tx,
        );

        // 6. The schedule is the contract's, to the rial; otherwise nothing of this stays.
        const schedule = await this.repayment.schedule(scheduleId, now, tx);
        const differs =
          schedule.totalRial !== facts.totalObligationRial ||
          schedule.installments.length !== facts.installments.length ||
          schedule.installments.some((i, n) => i.amountRial !== facts.installments[n]?.amountRial);
        if (differs) {
          throw conflict('schedule_differs_from_contract', {
            scheduleTotalRial: schedule.totalRial.toString(),
            contractTotalRial: facts.totalObligationRial.toString(),
          });
        }
        const purse = await this.wallet.summary(purseId, tx);
        if (ready.downPayment && down > 0n) {
          await this.completion.markDownPaymentFunded(
            ready.downPayment.postingId,
            purseId,
            purse.fundedAt ?? now,
            tx,
          );
        }

        const decided = await tx.execute(sql`
        UPDATE funding_requests
        SET status = 'approved', decided_by = ${actor.accountId}, decided_at = ${now},
            purse_id = ${purseId}, schedule_id = ${scheduleId}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
        const done = decided.rows[0] as RequestRow;
        await this.audit.record(
          {
            actor,
            action: 'wallet.funded',
            entityType: 'funding_request',
            entityId: id,
            before: { status: 'requested' },
            after: {
              status: 'approved',
              purseId,
              scheduleId,
              approvedAmountRial: facts.approvedAmountRial.toString(),
              downPaymentRial: down.toString(),
              planFeeRial: planFeeRial.toString(),
            },
          },
          tx,
        );
        await this.outbox.publish(
          {
            type: 'wallet.funded',
            aggregateType: 'funding_request',
            aggregateId: id,
            payload: {
              fundingRequestId: id,
              creditApplicationId: appId,
              caseId: facts.caseId,
              purseId,
              scheduleId,
              // For «patient ready» only (doc 12 §5): the SMS reads the doctor's mobile by it.
              doctorAccountId: facts.doctorAccountId,
            },
          },
          tx,
        );
        return done;
      })
      .catch(async (error: unknown) => {
        // ADR-051: a refusal by the cap is recorded on its own, after the funding rolled back.
        if (error instanceof BorrowerCapExceeded) await this.exposure.recordRefusal(error.refusal);
        throw error;
      });
    const facts = await this.facts.facts(row.credit_application_id);
    if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
    return this.view(row, facts, actor.accountId);
  }

  async reject(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<FundingRequestView> {
    this.require(access, 'wallet.approve_funding');
    if (!UUID.test(id)) throw notFound();
    const reached = await this.requestRow(this.db, id);
    const facts = await this.reachable(access, reached.credit_application_id);
    const row = await this.db.transaction(async (tx) => {
      const request = await this.lockRequest(tx, id);
      if (request.status !== 'requested')
        throw conflict('request_decided', { status: request.status });
      if (request.requested_by === actor.accountId) throw conflict('same_person');
      const decided = await tx.execute(sql`
        UPDATE funding_requests
        SET status = 'rejected', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const done = decided.rows[0] as RequestRow;
      await this.audit.record(
        {
          actor,
          action: 'wallet.funding_rejected',
          entityType: 'funding_request',
          entityId: id,
          before: { status: 'requested' },
          after: { status: 'rejected' },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'wallet.funding_rejected', done);
      return done;
    });
    return this.view(row, facts, actor.accountId);
  }

  // --- the patient's or borrower's view ------------------------------------------------

  async mine(
    accountId: string,
    creditApplicationId: string,
    now = new Date(),
  ): Promise<MyFundingView> {
    const facts = await this.ownApplication(accountId, creditApplicationId);
    // The purse's name on the patient's pages (task 4-7), never the money-wallet phrase (doc 01).
    const purseTitle = (await this.config.resolve('wallet.purse_title')).value;
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM funding_requests
      WHERE credit_application_id = ${creditApplicationId} AND status = 'approved'
    `);
    const funded = rows.rows[0] as RequestRow | undefined;
    if (!funded?.purse_id || !funded.schedule_id) {
      return {
        creditApplicationId,
        purseTitle,
        funded: false,
        fundedAt: null,
        approvedAmountRial: (facts.approvedAmountRial ?? 0n).toString(),
        downPaymentRial: facts.downPaymentRial.toString(),
        availableRial: '0',
        totalRial: '0',
        installments: [],
      };
    }
    const purse = await this.wallet.summary(funded.purse_id);
    const schedule = await this.repayment.schedule(funded.schedule_id, now);
    return {
      creditApplicationId,
      purseTitle,
      funded: true,
      fundedAt: purse.fundedAt?.toISOString() ?? null,
      approvedAmountRial: purse.approvedAmountRial.toString(),
      downPaymentRial: purse.downPaymentRial.toString(),
      availableRial: purse.balances.availableRial.toString(),
      totalRial: schedule.totalRial.toString(),
      installments: schedule.installments.map((i) => ({
        index: i.index,
        dueOn: i.dueOn,
        amountRial: i.amountRial.toString(),
        status: i.status,
      })),
    };
  }

  // --- helpers ------------------------------------------------------------------------

  private view(
    r: RequestRow,
    facts: CreditContractFacts,
    viewer: string | null,
  ): FundingRequestView {
    return {
      id: r.id,
      creditApplicationId: r.credit_application_id,
      status: r.status,
      requestedAt: r.requested_at,
      requestedByMe: viewer !== null && r.requested_by === viewer,
      decidedAt: r.decided_at,
      decisionReason: r.decision_reason,
      purseId: r.purse_id,
      scheduleId: r.schedule_id,
      approvedAmountRial: (facts.approvedAmountRial ?? 0n).toString(),
      downPaymentRial: facts.downPaymentRial.toString(),
      installmentCount: facts.installmentCount,
    };
  }

  private async requestRow(ex: SqlExecutor, id: string): Promise<RequestRow> {
    const rows = await ex.execute(sql`SELECT ${COLUMNS} FROM funding_requests WHERE id = ${id}`);
    const row = rows.rows[0] as RequestRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async lockRequest(ex: SqlExecutor, id: string): Promise<RequestRow> {
    const rows = await ex.execute(
      sql`SELECT ${COLUMNS} FROM funding_requests WHERE id = ${id} FOR UPDATE`,
    );
    const row = rows.rows[0] as RequestRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  /** Staff reach an application of their city, or any with a global scope (rule 13). */
  private async reachable(access: EffectiveAccess, creditApplicationId: string) {
    if (!UUID.test(creditApplicationId)) {
      throw new NotFoundException({ error: 'credit_application_not_found' });
    }
    const facts = await this.facts.facts(creditApplicationId);
    if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
    if (access.scopes.some((s) => s.kind === 'global')) return facts;
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    const proforma = await this.proformas.proforma(facts.proformaId);
    if (!proforma || !cities.includes(proforma.cityCode)) {
      throw new NotFoundException({ error: 'credit_application_not_found' });
    }
    return facts;
  }

  /** The application, if this account's person is its patient or borrower (rule 13). */
  private async ownApplication(accountId: string, creditApplicationId: string) {
    const notMine = new NotFoundException({ error: 'credit_application_not_found' });
    if (!UUID.test(creditApplicationId)) throw notMine;
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient') {
      throw new ForbiddenException({ error: 'patients_only' });
    }
    if (!account.personId) throw notMine;
    const persons = await this.leads.samePersonIds(
      await this.leads.canonicalPersonId(account.personId),
    );
    const facts = await this.facts.facts(creditApplicationId);
    if (
      !facts ||
      (!persons.includes(facts.borrowerPersonId) && !persons.includes(facts.patientPersonId))
    ) {
      throw notMine;
    }
    return facts;
  }

  private async publish(tx: SqlExecutor, type: string, row: RequestRow) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'funding_request',
        aggregateId: row.id,
        payload: { fundingRequestId: row.id, creditApplicationId: row.credit_application_id },
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
