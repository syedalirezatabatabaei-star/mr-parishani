import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  normalizeDigits,
  type PermissionCode,
  type RefundAccount,
  type RefundOwed,
  type RefundPaymentStatus,
  type RefundPaymentView,
  type RequestRefundPayment,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFacts,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { lockRefundAccount, type RefundAccountCode } from '../../common/ledger/refund-account-lock';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import { DownPaymentService } from './down-payment.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'refund_payment_not_found' });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

const ASK: PermissionCode = 'contract.request_refund_payment';
const DECIDE: PermissionCode = 'contract.approve_refund_payment';

const CODE_OF: Readonly<Record<RefundAccount, RefundAccountCode>> = {
  fee: 'fee.refund_payable',
  down_payment: 'downpayment.refund_payable',
};
const ACCOUNT_OF: Readonly<Record<RefundAccountCode, RefundAccount>> = {
  'fee.refund_payable': 'fee',
  'downpayment.refund_payable': 'down_payment',
};

interface Row {
  id: string;
  credit_application_id: string;
  entity_id: string;
  borrower_person_id: string;
  account_code: RefundAccountCode;
  amount_rial: string;
  bank_reference: string;
  paid_on: string;
  idempotency_key: string;
  reason: string;
  status: RefundPaymentStatus;
  requested_by: string;
  requested_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  journal_entry_id: string | null;
}

const iso = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const COLUMNS = sql.raw(`id, credit_application_id, entity_id, borrower_person_id, account_code,
  amount_rial::text AS amount_rial, bank_reference, paid_on::text AS paid_on, idempotency_key,
  reason, status, requested_by, ${iso('requested_at')}, ${iso('decided_at')}, decision_reason,
  journal_entry_id`);

/**
 * Refunds paid out by bank (task 4-8 [financial], part 4; ADR-036; owner 1405/07/14): Dr the
 * borrower's `fee.refund_payable` or `downpayment.refund_payable`, Cr `bank.settlement`.
 *
 * - Two people: recorded by one in accounting, approved by another (a CHECK, and here).
 * - The bank's tracking number is required and unique among payments not rejected.
 * - The client's idempotency key: the same request twice records one; with other content, 409.
 * - Never more than the account owes, checked when recorded and again when approved, under
 *   the account's lock (a cancellation's reversal takes it too): part may be paid, the
 *   balance never goes below zero.
 *
 * The posting is made on approval only, keyed `refund-payment:<id>`; approving twice
 * changes nothing (rule 5).
 */
@Injectable()
export class RefundPaymentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    private readonly downPayments: DownPaymentService,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async owed(access: EffectiveAccess, creditApplicationId: string): Promise<RefundOwed> {
    this.requireAny(access);
    const facts = await this.reachable(access, creditApplicationId);
    return this.db.transaction(async (tx) => {
      const entityId = await this.downPayments.entityOf(creditApplicationId, tx);
      const of = (code: RefundAccountCode) =>
        this.balance(tx, { entityId, code, borrowerPersonId: facts.borrowerPersonId });
      return {
        creditApplicationId,
        feeRial: (await of('fee.refund_payable')).toString(),
        downPaymentRial: (await of('downpayment.refund_payable')).toString(),
      };
    });
  }

  async request(
    actor: Actor,
    access: EffectiveAccess,
    input: RequestRefundPayment,
  ): Promise<RefundPaymentView> {
    this.require(access, ASK);
    const facts = await this.reachable(access, input.creditApplicationId);
    const code = CODE_OF[input.account];
    const amount = BigInt(input.amountRial);
    const reference = normalizeDigits(input.bankReference).trim();
    // ADR-052: the asker's own SMS code for this refund and its amount.
    await this.stepUp.assert(actor, {
      type: 'refund_payment',
      id: facts.creditApplicationId,
      amountRial: amount,
      step: 'request',
    });
    const row = await this.db
      .transaction(async (tx) => {
        const [earlier] = (
          await tx.execute(
            sql`SELECT ${COLUMNS} FROM refund_payments WHERE idempotency_key = ${input.idempotencyKey}`,
          )
        ).rows as unknown as Row[];
        if (earlier) {
          const same =
            earlier.credit_application_id === input.creditApplicationId &&
            earlier.account_code === code &&
            earlier.amount_rial === input.amountRial &&
            earlier.bank_reference === reference &&
            earlier.paid_on === input.paidOn;
          if (!same) throw conflict('idempotency_key_reused');
          return earlier;
        }
        const entityId = await this.downPayments.entityOf(input.creditApplicationId, tx);
        const account = { entityId, code, borrowerPersonId: facts.borrowerPersonId };
        // Checked again, under the account's lock, when approved.
        const owed = await this.balance(tx, account);
        if (amount > owed) throw conflict('exceeds_owed', { owedRial: owed.toString() });
        const made = await tx.execute(sql`
          INSERT INTO refund_payments (
            credit_application_id, entity_id, borrower_person_id, account_code, amount_rial,
            bank_reference, paid_on, idempotency_key, reason, requested_by
          ) VALUES (
            ${input.creditApplicationId}, ${entityId}, ${facts.borrowerPersonId}, ${code},
            ${amount}, ${reference}, ${input.paidOn}, ${input.idempotencyKey}, ${input.reason},
            ${actor.accountId}
          )
          RETURNING ${COLUMNS}
        `);
        const created = made.rows[0] as unknown as Row;
        await this.audit.record(
          {
            actor,
            action: 'contract.refund_payment_requested',
            entityType: 'refund_payment',
            entityId: created.id,
            after: { account: input.account, amountRial: input.amountRial, paidOn: input.paidOn },
            reason: input.reason,
          },
          tx,
        );
        await this.publish(tx, 'contract.refund_payment_requested', created);
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'refund_payments_reference_key')) {
          throw conflict('bank_reference_used');
        }
        if (isUniqueViolation(error, 'refund_payments_key_key')) {
          throw conflict('idempotency_key_reused');
        }
        throw error;
      });
    return view(row, actor.accountId);
  }

  async list(
    actor: Actor,
    access: EffectiveAccess,
    query: {
      creditApplicationId?: string | undefined;
      status?: RefundPaymentStatus | undefined;
    },
  ): Promise<RefundPaymentView[]> {
    this.requireAny(access);
    const rows = await this.db.execute(sql`
      SELECT ${COLUMNS} FROM refund_payments
      WHERE (${query.creditApplicationId ?? null}::uuid IS NULL
             OR credit_application_id = ${query.creditApplicationId ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY requested_at DESC LIMIT 500
    `);
    const out: RefundPaymentView[] = [];
    for (const r of rows.rows as unknown as Row[]) {
      const ok = await this.reachable(access, r.credit_application_id).then(
        () => true,
        () => false,
      );
      if (ok) out.push(view(r, actor.accountId));
    }
    return out;
  }

  async approve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<RefundPaymentView> {
    this.require(access, DECIDE);
    const reached = await this.find(id);
    await this.reachable(access, reached.credit_application_id);
    // ADR-052: the approver's own SMS code for this refund and its amount.
    await this.stepUp.assert(actor, {
      type: 'refund_payment',
      id,
      amountRial: BigInt(reached.amount_rial),
      step: 'approve',
    });
    const row = await this.db.transaction(async (tx) => {
      const payment = await this.lock(tx, id);
      // Approving twice changes nothing (rule 5).
      if (payment.status === 'approved') return payment;
      if (payment.status !== 'requested') throw conflict('request_decided');
      // Doc 12 §7: two people for anything that moves money.
      if (payment.requested_by === actor.accountId) throw conflict('same_person');
      const account = {
        entityId: payment.entity_id,
        code: payment.account_code,
        borrowerPersonId: payment.borrower_person_id,
      };
      await lockRefundAccount(tx, account);
      const amount = BigInt(payment.amount_rial);
      const owed = await this.balance(tx, account);
      // Owner: part may be paid; the account never below zero.
      if (amount > owed) throw conflict('exceeds_owed', { owedRial: owed.toString() });
      const refund = await this.ledger.findAccount(
        {
          entityId: account.entityId,
          code: account.code,
          ownerType: 'borrower',
          ownerId: account.borrowerPersonId,
        },
        tx,
      );
      if (!refund) throw conflict('exceeds_owed', { owedRial: '0' });
      const bank = await this.ledger.openAccount(
        {
          entityId: account.entityId,
          code: 'bank.settlement',
          name: 'حساب بانکی پرداخت',
          kind: 'asset',
          ownerType: 'company',
          ownerId: null,
        },
        tx,
      );
      const facts = await this.credit.facts(payment.credit_application_id);
      const journal = await this.ledger.postJournal(
        actor,
        {
          entityId: account.entityId,
          eventType: 'contract.refund_paid',
          // The day it was paid, noon in Tehran.
          occurredAt: new Date(`${payment.paid_on}T08:30:00Z`),
          idempotencyKey: `refund-payment:${payment.id}`,
          ...(facts ? { caseId: facts.caseId } : {}),
          creditApplicationId: payment.credit_application_id,
          lines: [
            { accountId: refund.id, direction: 'debit', amountRial: amount },
            { accountId: bank.id, direction: 'credit', amountRial: amount },
          ],
        },
        tx,
      );
      const done = await tx.execute(sql`
        UPDATE refund_payments
        SET status = 'approved', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason}, journal_entry_id = ${journal.id}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const approved = done.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: 'contract.refund_payment_approved',
          entityType: 'refund_payment',
          entityId: id,
          before: { status: 'requested' },
          after: { status: 'approved', journalEntryId: journal.id },
          reason,
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'contract.refund_payment_approved',
          aggregateType: 'refund_payment',
          aggregateId: id,
          payload: {
            refundPaymentId: id,
            creditApplicationId: payment.credit_application_id,
            journalEntryId: journal.id,
            amountRial: payment.amount_rial,
          },
        },
        tx,
      );
      return approved;
    });
    return view(row, actor.accountId);
  }

  async reject(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
  ): Promise<RefundPaymentView> {
    this.require(access, DECIDE);
    const reached = await this.find(id);
    await this.reachable(access, reached.credit_application_id);
    const row = await this.db.transaction(async (tx) => {
      const payment = await this.lock(tx, id);
      if (payment.status !== 'requested') throw conflict('request_decided');
      if (payment.requested_by === actor.accountId) throw conflict('same_person');
      const done = await tx.execute(sql`
        UPDATE refund_payments
        SET status = 'rejected', decided_by = ${actor.accountId}, decided_at = now(),
            decision_reason = ${reason}
        WHERE id = ${id}
        RETURNING ${COLUMNS}
      `);
      const rejected = done.rows[0] as unknown as Row;
      await this.audit.record(
        {
          actor,
          action: 'contract.refund_payment_rejected',
          entityType: 'refund_payment',
          entityId: id,
          before: { status: 'requested' },
          after: { status: 'rejected' },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'contract.refund_payment_rejected', rejected);
      return rejected;
    });
    return view(row, actor.accountId);
  }

  // --- helpers -------------------------------------------------------------------------

  /** What the account owes the borrower (a liability: credit minus debit); 0 without one. */
  private async balance(
    tx: Tx,
    account: { entityId: string; code: RefundAccountCode; borrowerPersonId: string },
  ): Promise<bigint> {
    const found = await this.ledger.findAccount(
      {
        entityId: account.entityId,
        code: account.code,
        ownerType: 'borrower',
        ownerId: account.borrowerPersonId,
      },
      tx,
    );
    if (!found) return 0n;
    const b = await this.ledger.balanceOf(found.id, undefined, tx);
    return b.creditRial - b.debitRial;
  }

  private async find(id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound();
    const rows = await this.db.execute(
      sql`SELECT ${COLUMNS} FROM refund_payments WHERE id = ${id}`,
    );
    const row = rows.rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  private async lock(tx: Tx, id: string): Promise<Row> {
    const rows = await tx.execute(
      sql`SELECT ${COLUMNS} FROM refund_payments WHERE id = ${id} FOR UPDATE`,
    );
    const row = rows.rows[0] as unknown as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  /** Staff reach an application of their city (its proforma's), or any with a global scope. */
  private async reachable(
    access: EffectiveAccess,
    creditApplicationId: string,
  ): Promise<CreditContractFacts> {
    const missing = () => new NotFoundException({ error: 'credit_application_not_found' });
    if (!UUID.test(creditApplicationId)) throw missing();
    const facts = await this.credit.facts(creditApplicationId);
    if (!facts) throw missing();
    if (access.scopes.some((s) => s.kind === 'global')) return facts;
    const proforma = await this.proformas.proforma(facts.proformaId);
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    if (!proforma || !cities.includes(proforma.cityCode)) throw missing();
    return facts;
  }

  private async publish(tx: Tx, type: string, row: Row) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'refund_payment',
        aggregateId: row.id,
        payload: { refundPaymentId: row.id, creditApplicationId: row.credit_application_id },
      },
      tx,
    );
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }

  private requireAny(access: EffectiveAccess) {
    if (!access.permissions.has(ASK) && !access.permissions.has(DECIDE)) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
  }
}

function view(r: Row, viewer: string | null): RefundPaymentView {
  return {
    id: r.id,
    creditApplicationId: r.credit_application_id,
    account: ACCOUNT_OF[r.account_code],
    amountRial: r.amount_rial,
    bankReference: r.bank_reference,
    paidOn: r.paid_on,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requested_at,
    requestedByMe: viewer !== null && r.requested_by === viewer,
    decidedAt: r.decided_at,
    decisionReason: r.decision_reason,
    journalEntryId: r.journal_entry_id,
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const c = e.cause ?? e;
  return c.code === '23505' && c.constraint === constraint;
}
