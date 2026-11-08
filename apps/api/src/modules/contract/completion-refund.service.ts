import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { unearnedPlanFee, type CreditRefundLine } from '@sepehr/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import type { CompletionRefundsPort } from '../../common/contract/completion-refunds.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { assertIncomeEntity } from '../../common/ledger/income-entities';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import type { Database } from '../../db/database.module';
import { completionReceipts } from './contract.schema';
import { DownPaymentService, receiptKey } from './down-payment.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ReceiptRow = typeof completionReceipts.$inferSelect;
interface RefundRow {
  readonly receipt_id: string;
  readonly kind: ReceiptRow['kind'];
  readonly amount_rial: string;
  readonly journal_entry_id: string;
}

/** What Aramesh owes a borrower back of a fee paid for an application later cancelled. */
const FEE_REFUND_PAYABLE = {
  code: 'fee.refund_payable',
  kind: 'liability',
  name: 'استرداد هزینه‌های پرونده به وام‌گیرنده',
} as const;
/** ADR-036: the same account the wallet credits for a down payment cancelled after funding. */
const DOWN_PAYMENT_REFUND_PAYABLE = {
  code: 'downpayment.refund_payable',
  kind: 'liability',
  name: 'استرداد پیش‌پرداخت به وام‌گیرنده',
} as const;

const EVENT: Readonly<Record<ReceiptRow['kind'], string>> = {
  origination_fee: 'contract.origination_fee_refunded',
  plan_fee: 'contract.plan_fee_refunded',
  down_payment: 'contract.down_payment_refunded',
};

/**
 * The refunds of a credit application cancelled before funding (task 4-8 [financial], part
 * 3; owner 1405/07/14, س۱ and س۲): see {@link CompletionRefundsPort}. Each refund is a new
 * document; the receipt, its fee document and its down-payment posting stay as they were
 * (rule 3), and `completion_refunds` (append-only) records which receipt it refunds.
 */
@Injectable()
export class CompletionRefundService implements CompletionRefundsPort {
  constructor(
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    private readonly downPayments: DownPaymentService,
  ) {}

  async refundAll(
    actor: Actor,
    creditApplicationId: string,
    cancellationId: string,
    executor: SqlExecutor,
  ): Promise<CreditRefundLine[]> {
    const tx = executor as Tx;
    const facts = await this.credit.facts(creditApplicationId);
    if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
    // Every receipt, whatever its state, in one order: an approval waits for us, or we for it.
    const receipts = await tx
      .select()
      .from(completionReceipts)
      .where(eq(completionReceipts.creditApplicationId, creditApplicationId))
      .orderBy(asc(completionReceipts.id))
      .for('update');
    const lines: CreditRefundLine[] = [];
    for (const receipt of receipts) {
      if (receipt.status !== 'approved' || receipt.deletedAt) continue;
      const [earlier] = (
        await tx.execute(sql`
          SELECT receipt_id, kind, amount_rial::text AS amount_rial, journal_entry_id
          FROM completion_refunds WHERE receipt_id = ${receipt.id}
        `)
      ).rows as unknown as RefundRow[];
      const refund =
        earlier ??
        (await this.refund(
          actor,
          receipt,
          facts.caseId,
          facts.borrowerPersonId,
          cancellationId,
          tx,
        ));
      if (refund) lines.push(lineOf(refund));
    }
    return lines;
  }

  async refundUnearnedPlanFee(
    actor: Actor,
    input: {
      readonly creditApplicationId: string;
      readonly operationId: string;
      readonly today: string;
      readonly installments: readonly { readonly index: number; readonly dueOn: string }[];
    },
    executor: SqlExecutor,
  ): Promise<CreditRefundLine | null> {
    const tx = executor as Tx;
    const facts = await this.credit.facts(input.creditApplicationId);
    if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
    if (facts.planFeeTiming !== 'at_completion') return null;
    const [receipt] = await tx
      .select()
      .from(completionReceipts)
      .where(
        and(
          eq(completionReceipts.creditApplicationId, input.creditApplicationId),
          eq(completionReceipts.kind, 'plan_fee'),
          eq(completionReceipts.status, 'approved'),
          isNull(completionReceipts.deletedAt),
        ),
      )
      .orderBy(asc(completionReceipts.id))
      .limit(1)
      .for('update');
    if (!receipt) return null;
    const [earlier] = (
      await tx.execute(sql`
        SELECT receipt_id, kind, amount_rial::text AS amount_rial, journal_entry_id
        FROM completion_refunds WHERE receipt_id = ${receipt.id}
      `)
    ).rows as unknown as RefundRow[];
    if (earlier) return lineOf(earlier);
    const unearned = unearnedPlanFee({
      feeRial: receipt.amountRial,
      installments: input.installments,
      today: input.today,
    });
    if (unearned === 0n) return null;
    const row = await this.refund(
      actor,
      receipt,
      facts.caseId,
      facts.borrowerPersonId,
      input.operationId,
      tx,
      unearned,
    );
    return row ? lineOf(row) : null;
  }

  /**
   * One receipt's refund; null for a down payment already reversed (nothing is held). The
   * whole receipt, or `amountRial` of it (ADR-045: a plan fee's unearned part).
   */
  private async refund(
    actor: Actor,
    receipt: ReceiptRow,
    caseId: string,
    borrowerPersonId: string,
    cancellationId: string,
    tx: Tx,
    amountRial: bigint = receipt.amountRial,
  ): Promise<RefundRow | null> {
    let entityId: string;
    let debit: string;
    let credit: string;
    if (receipt.kind === 'down_payment') {
      // Posted now if it was approved before ADR-034 (its own key; once).
      const posting = await this.downPayments.post(actor, receipt, tx);
      if (posting.reversalJournalEntryId) return null;
      if (posting.fundedPurseId) throw new ConflictException({ error: 'already_funded' });
      entityId = posting.entityId;
      debit = await this.downPayments.heldAccount(entityId, posting.borrowerPersonId, tx);
      credit = (
        await this.ledger.openAccount(
          {
            entityId,
            ...DOWN_PAYMENT_REFUND_PAYABLE,
            ownerType: 'borrower',
            ownerId: posting.borrowerPersonId,
          },
          tx,
        )
      ).id;
      borrowerPersonId = posting.borrowerPersonId;
    } else {
      entityId = await this.downPayments.entityOf(receipt.creditApplicationId, tx);
      // The fee was income of this entity only (ADR-007); so is its refund.
      assertIncomeEntity(entityId);
      debit = (
        await this.ledger.openAccount(
          {
            entityId,
            code: 'company.fee_income',
            name: 'درآمد کارمزد',
            kind: 'income',
            ownerType: 'company',
            ownerId: null,
          },
          tx,
        )
      ).id;
      credit = (
        await this.ledger.openAccount(
          { entityId, ...FEE_REFUND_PAYABLE, ownerType: 'borrower', ownerId: borrowerPersonId },
          tx,
        )
      ).id;
    }
    const journal = await this.ledger.postJournal(
      actor,
      {
        entityId,
        eventType: EVENT[receipt.kind],
        occurredAt: new Date(),
        idempotencyKey: `${receiptKey(receipt.id)}:refund`,
        caseId,
        creditApplicationId: receipt.creditApplicationId,
        lines: [
          { accountId: debit, direction: 'debit', amountRial },
          { accountId: credit, direction: 'credit', amountRial },
        ],
      },
      tx,
    );
    const [row] = (
      await tx.execute(sql`
        INSERT INTO completion_refunds (
          receipt_id, credit_application_id, kind, entity_id, borrower_person_id, amount_rial,
          journal_entry_id, cancellation_id, created_by
        ) VALUES (
          ${receipt.id}, ${receipt.creditApplicationId}, ${receipt.kind}, ${entityId},
          ${borrowerPersonId}, ${amountRial}, ${journal.id}, ${cancellationId},
          ${actor.accountId ?? receipt.decidedBy ?? receipt.uploadedBy}
        )
        RETURNING receipt_id, kind, amount_rial::text AS amount_rial, journal_entry_id
      `)
    ).rows as unknown as RefundRow[];
    if (!row) throw new Error('refund insert returned nothing');
    await this.audit.record(
      {
        actor,
        action: 'contract.receipt_refunded',
        entityType: 'completion_receipt',
        entityId: receipt.id,
        after: {
          journalEntryId: journal.id,
          kind: receipt.kind,
          amountRial: amountRial.toString(),
          cancellationId,
        },
      },
      tx,
    );
    await this.outbox.publish(
      {
        type: 'contract.receipt_refunded',
        aggregateType: 'completion_receipt',
        aggregateId: receipt.id,
        payload: {
          creditApplicationId: receipt.creditApplicationId,
          receiptId: receipt.id,
          kind: receipt.kind,
          journalEntryId: journal.id,
          amountRial: amountRial.toString(),
        },
      },
      tx,
    );
    return row;
  }
}

function lineOf(r: RefundRow): CreditRefundLine {
  return {
    receiptId: r.receipt_id,
    kind: r.kind,
    amountRial: r.amount_rial,
    journalEntryId: r.journal_entry_id,
  };
}
