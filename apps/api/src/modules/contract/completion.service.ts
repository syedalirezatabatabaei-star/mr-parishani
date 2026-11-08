import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CompletionReceiptKind,
  CompletionReceiptView,
  CompletionStatus,
  PermissionCode,
} from '@sepehr/contracts';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFacts,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import {
  DELIVERY_STATUS,
  type DeliveryStatusPort,
} from '../../common/instrument/delivery-status.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { assertIncomeEntity } from '../../common/ledger/income-entities';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../../common/payment/payment-provider.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';
import { storageUnavailable } from '../../infra/s3-storage';
import { caseCompletions, completionReceipts, contracts } from './contract.schema';
import { DownPaymentService } from './down-payment.service';
import {
  OriginationFeeService,
  originationView,
  type OriginationNow,
} from './origination-fee.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ReceiptRow = typeof completionReceipts.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long a receipt's signed link lives. */
const LINK_SECONDS = 300;
const receiptNotFound = () => new NotFoundException({ error: 'receipt_not_found' });
const APPROVED = ['approved', 'conditional'];

/** The ledger event of each fee's approval; the down payment posts nothing yet (owner, پ۳). */
const FEE_EVENT: Readonly<Record<Exclude<CompletionReceiptKind, 'down_payment'>, string>> = {
  origination_fee: 'contract.origination_fee_received',
  plan_fee: 'contract.plan_fee_received',
};

/**
 * Completion of a credit application (task 4-3 [financial]; doc 12 §4; owner 1405/07/11).
 *
 * The receipts an application owes come through the PaymentProvider (ADR-009, the manual
 * receipt): the origination fee; the plan fee when it is paid at completion; the down
 * payment, to Aramesh Sarvat, when there is one. Finance approves each at exactly the
 * amount owed (پ۴), and only then is its journal posted (پ۱), through the ledger's port,
 * in the same transaction with the receipt locked, keyed to the receipt (rule 5):
 *
 * - origination fee and plan fee at completion: debit `bank.collection`, credit
 *   `company.fee_income` (doc 02 §4; پ۲);
 * - down payment: no entry yet (پ۳); its ledger entry comes with 4-5's ADR.
 *
 * Completed when every condition of doc 12 §4 holds, checked here, never in the UI: the
 * contract accepted by all; the delivery verified with its instruments; every condition
 * ticked; every receipt approved; the cheque rule met (owner 1405/07/29, ج۵: the borrower's
 * checked cheques at least `instrument.borrower_cheque_min_count`, each guarantor's together at
 * least `instrument.guarantee_cheque_min_bps` of the proforma's total; 0 = off). `completed_at`
 * is an indicator only (doc 02 §5); the completion's audit keeps the rule's two versions.
 */
@Injectable()
export class CompletionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(DELIVERY_STATUS) private readonly deliveries: DeliveryStatusPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly downPayments: DownPaymentService,
    private readonly originationFees: OriginationFeeService,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  // --- the payer --------------------------------------------------------------------

  async upload(
    actor: Actor,
    accountId: string,
    creditApplicationId: string,
    input: { kind: CompletionReceiptKind; amountRial: bigint; paidOn: string; reference: string },
    file: { buffer: Buffer; size: number } | undefined,
  ): Promise<CompletionReceiptView> {
    if (!file) throw new BadRequestException({ error: 'file_required' });
    const facts = await this.ownApplication(accountId, creditApplicationId);
    if (!APPROVED.includes(facts.status)) {
      throw new ConflictException({ error: 'not_approved', status: facts.status });
    }
    if (await this.completedAt(facts.creditApplicationId)) {
      throw new ConflictException({ error: 'already_completed' });
    }
    const owedNow = this.owed(facts, await this.originationFees.now(facts));
    if (!owedNow.some((o) => o.kind === input.kind)) {
      throw new BadRequestException({ error: 'not_owed', kind: input.kind });
    }

    const idRow = await this.db.execute(sql`SELECT uuidv7() AS id`);
    const receiptId = idRow.rows[0]?.['id'] as string;
    const evidence = await this.payments.keepEvidence(
      `completion-receipts/${facts.creditApplicationId}/${receiptId}`,
      file.buffer,
    );
    const row = await this.db
      .transaction(async (tx) => {
        // ADR-048: the origination fee is read again under its lock and locked with the receipt,
        // so a discount granted meanwhile is either in it or refused.
        let origination: OriginationNow | null = null;
        if (input.kind === 'origination_fee') {
          await this.originationFees.lock(tx, facts.creditApplicationId);
          origination = await this.originationFees.now(facts, tx);
        }
        const owed = this.owed(
          facts,
          origination ?? (await this.originationFees.now(facts, tx)),
        ).find((o) => o.kind === input.kind);
        if (!owed) throw new BadRequestException({ error: 'not_owed', kind: input.kind });
        const [made] = await tx
          .insert(completionReceipts)
          .values({
            id: receiptId,
            creditApplicationId: facts.creditApplicationId,
            kind: input.kind,
            amountRial: input.amountRial,
            expectedRial: owed.expectedRial,
            paidOn: input.paidOn,
            reference: input.reference,
            ...evidence,
            uploadedBy: accountId,
          })
          .returning();
        if (!made) throw new Error('receipt insert returned nothing');
        if (origination) await this.originationFees.lockOwed(tx, facts, origination, made.id);
        await this.audit.record(
          {
            actor,
            action: 'contract.receipt_uploaded',
            entityType: 'completion_receipt',
            entityId: made.id,
            after: {
              creditApplicationId: made.creditApplicationId,
              kind: made.kind,
              amountRial: made.amountRial.toString(),
            },
          },
          tx,
        );
        await this.publish(tx, 'contract.receipt_uploaded', made);
        return made;
      })
      .catch((error: unknown) => {
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') {
          throw new ConflictException({ error: 'receipt_exists' });
        }
        throw error;
      });
    return receiptView(row);
  }

  async mine(accountId: string, creditApplicationId: string): Promise<CompletionStatus> {
    return this.statusOf(await this.ownApplication(accountId, creditApplicationId));
  }

  // --- finance ----------------------------------------------------------------------

  /** Receipts waiting for finance, oldest first. */
  async pending(access: EffectiveAccess): Promise<CompletionReceiptView[]> {
    this.require(access, 'repayment.approve_payment');
    const rows = await this.db
      .select()
      .from(completionReceipts)
      .where(eq(completionReceipts.status, 'pending_approval'))
      .orderBy(asc(completionReceipts.createdAt));
    const visible: ReceiptRow[] = [];
    for (const r of rows) {
      if (
        await this.reachable(access, r.creditApplicationId).then(
          () => true,
          () => false,
        )
      ) {
        visible.push(r);
      }
    }
    return visible.map(receiptView);
  }

  async approve(actor: Actor, access: EffectiveAccess, id: string): Promise<CompletionReceiptView> {
    this.require(access, 'repayment.approve_payment');
    const reached = await this.staffReceipt(access, id);
    const facts = await this.reachable(access, reached.creditApplicationId);
    // ADR-052: one person, with their own SMS code for this receipt and its amount.
    await this.stepUp.assert(actor, {
      type: 'completion_receipt',
      id: reached.id,
      amountRial: reached.amountRial,
      step: 'approve',
    });
    const entityId = await this.entityOf(reached.creditApplicationId);
    const row = await this.db.transaction(async (tx) => {
      const receipt = await this.lockReceipt(tx, reached.id);
      // Approving twice changes nothing (rule 5).
      if (receipt.status === 'approved') return receipt;
      if (receipt.status === 'rejected') throw new ConflictException({ error: 'receipt_rejected' });
      // Task 4-8: re-read under the receipt's lock; a cancellation locks every receipt first.
      const now = await this.credit.facts(receipt.creditApplicationId);
      if (now?.status === 'cancelled') {
        throw new ConflictException({ error: 'application_cancelled' });
      }
      // Maker-checker (doc 04 §5): who uploaded a receipt never approves it.
      if (receipt.uploadedBy === actor.accountId) {
        throw new ConflictException({ error: 'same_person' });
      }
      if (receipt.amountRial !== receipt.expectedRial) {
        // Owner, پ۴: only the exact amount; finance rejects it with a reason.
        throw new ConflictException({
          error: 'amount_mismatch',
          amountRial: receipt.amountRial.toString(),
          expectedRial: receipt.expectedRial.toString(),
        });
      }
      let journalEntryId: string | null = null;
      if (receipt.kind !== 'down_payment') {
        // Income only to an entity that may earn it (ADR-007), whatever a contract says.
        assertIncomeEntity(entityId);
        const bank = await this.ledger.openAccount(
          {
            entityId,
            code: 'bank.collection',
            name: 'حساب دریافت اقساط',
            kind: 'asset',
            ownerType: 'company',
            ownerId: null,
          },
          tx,
        );
        const income = await this.ledger.openAccount(
          {
            entityId,
            code: 'company.fee_income',
            name: 'درآمد کارمزد',
            kind: 'income',
            ownerType: 'company',
            ownerId: null,
          },
          tx,
        );
        const journal = await this.ledger.postJournal(
          actor,
          {
            entityId,
            eventType: FEE_EVENT[receipt.kind],
            // The day it was paid, noon in Tehran.
            occurredAt: new Date(`${receipt.paidOn}T08:30:00Z`),
            idempotencyKey: `contract:receipt:${receipt.id}`,
            caseId: facts.caseId,
            creditApplicationId: receipt.creditApplicationId,
            lines: [
              { accountId: bank.id, direction: 'debit', amountRial: receipt.amountRial },
              { accountId: income.id, direction: 'credit', amountRial: receipt.amountRial },
            ],
          },
          tx,
        );
        journalEntryId = journal.id;
      }
      const [done] = await tx
        .update(completionReceipts)
        .set({
          status: 'approved',
          journalEntryId,
          decidedBy: actor.accountId,
          decidedAt: new Date(),
        })
        .where(eq(completionReceipts.id, receipt.id))
        .returning();
      if (!done) throw new Error('receipt update returned nothing');
      // ADR-034 (task 4-5): the down payment is posted too, on its link row, in this
      // transaction; the receipt's own row stays as 4-3 left it (owner, decision 3).
      if (done.kind === 'down_payment') await this.downPayments.post(actor, done, tx);
      await this.audit.record(
        {
          actor,
          action: 'contract.receipt_approved',
          entityType: 'completion_receipt',
          entityId: done.id,
          before: { status: receipt.status },
          after: { status: 'approved', journalEntryId },
        },
        tx,
      );
      await this.publish(tx, 'contract.receipt_approved', done);
      return done;
    });
    return receiptView(row);
  }

  async reject(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    this.require(access, 'repayment.approve_payment');
    const reached = await this.staffReceipt(access, id);
    const row = await this.db.transaction(async (tx) => {
      const receipt = await this.lockReceipt(tx, reached.id);
      if (receipt.status !== 'pending_approval') {
        throw new ConflictException({ error: 'receipt_decided', status: receipt.status });
      }
      const [done] = await tx
        .update(completionReceipts)
        .set({
          status: 'rejected',
          rejectionReason: reason,
          decidedBy: actor.accountId,
          decidedAt: new Date(),
        })
        .where(eq(completionReceipts.id, receipt.id))
        .returning();
      if (!done) throw new Error('receipt update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'contract.receipt_rejected',
          entityType: 'completion_receipt',
          entityId: done.id,
          after: { status: 'rejected' },
          reason,
        },
        tx,
      );
      await this.publish(tx, 'contract.receipt_rejected', done);
      return done;
    });
    return receiptView(row);
  }

  async link(actor: Actor, access: EffectiveAccess, id: string) {
    if (
      !access.permissions.has('repayment.approve_payment') &&
      !access.permissions.has('contract.read')
    ) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const row = await this.staffReceipt(access, id);
    if (!this.storage.configured) throw storageUnavailable();
    const url = await this.storage.signedUrl(row.storageKey, LINK_SECONDS);
    await this.audit.recordView(actor, 'completion_receipt', row.id);
    return { url, expiresInSeconds: LINK_SECONDS };
  }

  // --- case completion --------------------------------------------------------------

  async status(access: EffectiveAccess, creditApplicationId: string): Promise<CompletionStatus> {
    if (
      !access.permissions.has('contract.read') &&
      !access.permissions.has('repayment.approve_payment')
    ) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    return this.statusOf(await this.reachable(access, creditApplicationId), true);
  }

  /** Recorded once every condition of doc 12 §4 holds; checked here, not in the UI. */
  async complete(
    actor: Actor,
    access: EffectiveAccess,
    creditApplicationId: string,
    now = new Date(),
  ) {
    this.require(access, 'contract.complete');
    const facts = await this.reachable(access, creditApplicationId);
    const { status, chequeRule } = await this.evaluate(facts);
    if (status.completedAt) throw new ConflictException({ error: 'already_completed' });
    if (status.missing.length > 0) {
      throw new ConflictException({ error: 'not_complete', missing: status.missing });
    }
    await this.db
      .transaction(async (tx) => {
        // ADR-048: nothing left to pay of the origination fee is locked here, once.
        await this.originationFees.lock(tx, facts.creditApplicationId);
        const origination = await this.originationFees.now(facts, tx);
        if (origination && !origination.locked) {
          if (origination.netRial !== 0n) {
            throw new ConflictException({
              error: 'not_complete',
              missing: ['receipt:origination_fee'],
            });
          }
          await this.originationFees.lockOwed(tx, facts, origination, null);
        }
        await tx.insert(caseCompletions).values({
          creditApplicationId: facts.creditApplicationId,
          completedBy: actor.accountId ?? '',
          completedAt: now,
        });
        await this.audit.record(
          {
            actor,
            action: 'contract.completed',
            entityType: 'credit_application',
            entityId: facts.creditApplicationId,
            after: {
              completedAt: now.toISOString(),
              // The cheque rule's versions it was completed under (rule 16).
              chequeRule,
            },
          },
          tx,
        );
        await this.outbox.publish(
          {
            type: 'contract.completed',
            aggregateType: 'credit_application',
            aggregateId: facts.creditApplicationId,
            payload: { creditApplicationId: facts.creditApplicationId },
          },
          tx,
        );
      })
      .catch((error: unknown) => {
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') {
          throw new ConflictException({ error: 'already_completed' });
        }
        throw error;
      });
    return this.statusOf(facts, true);
  }

  // --- helpers ----------------------------------------------------------------------

  /**
   * What the application owes before completion, from its decision's preview; the origination
   * fee as ADR-048 leaves it (none when its reductions leave nothing to pay).
   */
  private owed(
    facts: CreditContractFacts,
    origination: OriginationNow | null,
  ): { kind: CompletionReceiptKind; expectedRial: bigint }[] {
    const owed: { kind: CompletionReceiptKind; expectedRial: bigint }[] = [];
    if (origination && origination.netRial > 0n) {
      owed.push({ kind: 'origination_fee', expectedRial: origination.netRial });
    }
    if (facts.planFeeTiming === 'at_completion' && facts.planFeeRial > 0n) {
      owed.push({ kind: 'plan_fee', expectedRial: facts.planFeeRial });
    }
    if (facts.downPaymentRial > 0n) {
      owed.push({ kind: 'down_payment', expectedRial: facts.downPaymentRial });
    }
    return owed;
  }

  /**
   * The cheque rule (ج۵), as in effect now: what is short, and the two versions it was read from.
   * A guarantor is named by their place among the application's guarantors (0 = the first).
   */
  private async chequeShortfalls(facts: CreditContractFacts) {
    const count = await this.config.resolve('instrument.borrower_cheque_min_count');
    const bps = await this.config.resolve('instrument.guarantee_cheque_min_bps');
    const versions = {
      borrowerMinCountVersionId: count.versionId,
      guaranteeMinBpsVersionId: bps.versionId,
    };
    const missing: string[] = [];
    if (count.value === 0 && (bps.value === 0 || facts.guarantors.length === 0)) {
      return { missing, versions };
    }
    const cheques = await this.deliveries.checkedCheques(facts.creditApplicationId);
    const borrower = cheques.filter((c) => c.role === 'borrower').length;
    if (borrower < count.value) missing.push('cheque:borrower');
    if (bps.value > 0 && facts.guarantors.length > 0) {
      const proforma = await this.proformas.proforma(facts.proformaId);
      if (!proforma) throw new Error('the application has no proforma');
      // Rounded up to the rial: a guarantee never falls short by a fraction.
      const needed = (proforma.totalRial * BigInt(bps.value) + 9_999n) / 10_000n;
      facts.guarantors.forEach((g, index) => {
        const given = cheques
          .filter((c) => c.role === 'guarantor' && c.guarantorId === g.id)
          .reduce((sum, c) => sum + c.amountRial, 0n);
        if (given < needed) missing.push(`cheque:guarantor:${String(index)}`);
      });
    }
    return { missing, versions };
  }

  private async statusOf(facts: CreditContractFacts, staff = false): Promise<CompletionStatus> {
    return (await this.evaluate(facts, staff)).status;
  }

  private async evaluate(facts: CreditContractFacts, staff = false) {
    const id = facts.creditApplicationId;
    const origination = await this.originationFees.now(facts);
    const [accepted] = await this.db
      .select({ id: contracts.id })
      .from(contracts)
      .where(and(eq(contracts.creditApplicationId, id), eq(contracts.status, 'accepted')))
      .limit(1);
    const deliveryVerified = await this.deliveries.isVerified(id);
    const receipts = await this.db
      .select()
      .from(completionReceipts)
      .where(eq(completionReceipts.creditApplicationId, id))
      .orderBy(desc(completionReceipts.createdAt));
    const owed = this.owed(facts, origination).map((o) => ({
      kind: o.kind,
      expectedRial: o.expectedRial.toString(),
      approved: receipts.some((r) => r.kind === o.kind && r.status === 'approved'),
    }));
    const conditions = facts.status === 'conditional' ? facts.conditions : [];
    const missing: string[] = [];
    if (!APPROVED.includes(facts.status)) missing.push('approval');
    if (!accepted) missing.push('contract');
    if (!deliveryVerified) missing.push('delivery');
    for (const c of conditions)
      if (c.checkedAt === null) missing.push(`condition:${String(c.index)}`);
    for (const o of owed) if (!o.approved) missing.push(`receipt:${o.kind}`);
    const cheques = await this.chequeShortfalls(facts);
    missing.push(...cheques.missing);
    const completedAt = await this.completedAt(id);
    const status: CompletionStatus = {
      creditApplicationId: id,
      completedAt: completedAt?.toISOString() ?? null,
      contractAccepted: accepted !== undefined,
      deliveryVerified,
      conditions: conditions.map((c) => ({
        index: c.index,
        text: c.text,
        checkedAt: c.checkedAt?.toISOString() ?? null,
      })),
      owed,
      receipts: receipts.map(receiptView),
      origination: originationView(
        origination,
        staff && origination?.discount
          ? await this.originationFees.discountView(origination.discount)
          : null,
      ),
      missing,
    };
    return { status, chequeRule: cheques.versions };
  }

  private async completedAt(creditApplicationId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: caseCompletions.completedAt })
      .from(caseCompletions)
      .where(eq(caseCompletions.creditApplicationId, creditApplicationId));
    return row?.at ?? null;
  }

  /** The lender: the application's contract's, else the template's (ADR-007). */
  private async entityOf(creditApplicationId: string): Promise<string> {
    const [contract] = await this.db
      .select({ entityId: contracts.entityId })
      .from(contracts)
      .where(
        and(eq(contracts.creditApplicationId, creditApplicationId), ne(contracts.status, 'failed')),
      )
      .limit(1);
    return (
      contract?.entityId ??
      (await this.config.resolve('contract.loan_template')).value.lender.entityId
    );
  }

  private async lockReceipt(tx: Tx, id: string): Promise<ReceiptRow> {
    const [row] = await tx
      .select()
      .from(completionReceipts)
      .where(eq(completionReceipts.id, id))
      .for('update');
    if (!row) throw receiptNotFound();
    return row;
  }

  private async staffReceipt(access: EffectiveAccess, id: string): Promise<ReceiptRow> {
    if (!UUID.test(id)) throw receiptNotFound();
    const [row] = await this.db
      .select()
      .from(completionReceipts)
      .where(eq(completionReceipts.id, id));
    if (!row) throw receiptNotFound();
    await this.reachable(access, row.creditApplicationId).catch(() => {
      throw receiptNotFound();
    });
    return row;
  }

  private async reachable(access: EffectiveAccess, creditApplicationId: string) {
    const facts = await this.credit.facts(creditApplicationId);
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
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient')
      throw new ForbiddenException({ error: 'patients_only' });
    const persons = account.personId
      ? await this.leads.samePersonIds(await this.leads.canonicalPersonId(account.personId))
      : [];
    const facts = await this.credit.facts(creditApplicationId);
    if (
      !facts ||
      (!persons.includes(facts.patientPersonId) && !persons.includes(facts.borrowerPersonId))
    ) {
      throw new NotFoundException({ error: 'credit_application_not_found' });
    }
    return facts;
  }

  private async publish(tx: Tx, type: string, row: ReceiptRow) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'completion_receipt',
        aggregateId: row.id,
        payload: { receiptId: row.id, creditApplicationId: row.creditApplicationId },
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

function receiptView(r: ReceiptRow): CompletionReceiptView {
  return {
    id: r.id,
    creditApplicationId: r.creditApplicationId,
    kind: r.kind,
    amountRial: r.amountRial.toString(),
    expectedRial: r.expectedRial.toString(),
    paidOn: r.paidOn,
    reference: r.reference,
    status: r.status,
    rejectionReason: r.rejectionReason,
    journalEntryId: r.journalEntryId,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  };
}
