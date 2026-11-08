import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import type {
  CompletionStatusPort,
  FundingReadiness,
} from '../../common/contract/completion-status.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { assertIncomeEntity } from '../../common/ledger/income-entities';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import {
  caseCompletions,
  completionReceipts,
  contracts,
  downPaymentPostings,
} from './contract.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ReceiptRow = typeof completionReceipts.$inferSelect;
type PostingRow = typeof downPaymentPostings.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ error: 'receipt_not_found' });

/** The ledger key of a receipt's posting (owner, 1405/07/11): the same as the fees'. */
export const receiptKey = (receiptId: string) => `contract:receipt:${receiptId}`;

/**
 * The down payment in the ledger (ADR-034; task 4-5 [financial]). Approving a down
 * payment's receipt posts Dr `bank.collection`, Cr the borrower's `downpayment.held`,
 * with the receipt's key; the posting is recorded in `down_payment_postings`, never on the
 * receipt's row (owner, decision 3). Funding moves it into the purse; before that, finance
 * may reverse it with the full opposite document. Receipts approved before ADR-034 are
 * posted once, the same way, by `postMissing` (the CLI) or by funding itself.
 *
 * Also the contract module's side of COMPLETION_STATUS: funding reads completion and the
 * down payment here, locked in its own transaction (owner's requirements 2 and 3).
 */
@Injectable()
export class DownPaymentService implements CompletionStatusPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
  ) {}

  /**
   * Posts an approved down payment's receipt, in `tx` with the receipt's row locked by the
   * caller. Once: a posting already made is returned as it is (rule 5).
   */
  async post(actor: Actor, receipt: ReceiptRow, tx: Tx): Promise<PostingRow> {
    if (receipt.kind !== 'down_payment' || receipt.status !== 'approved') {
      throw new ConflictException({ error: 'not_an_approved_down_payment' });
    }
    const [earlier] = await tx
      .select()
      .from(downPaymentPostings)
      .where(eq(downPaymentPostings.receiptId, receipt.id))
      .for('update');
    if (earlier) return earlier;

    const facts = await this.credit.facts(receipt.creditApplicationId);
    if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
    const entityId = await this.entityOf(receipt.creditApplicationId, tx);
    // The down payment goes to Aramesh Sarvat (doc 12 §5), whatever a contract says.
    assertIncomeEntity(entityId);
    const bank = await this.bankAccount(entityId, tx);
    const held = await this.heldAccount(entityId, facts.borrowerPersonId, tx);
    const journal = await this.ledger.postJournal(
      actor,
      {
        entityId,
        eventType: 'contract.down_payment_received',
        // The day it was paid, noon in Tehran.
        occurredAt: new Date(`${receipt.paidOn}T08:30:00Z`),
        idempotencyKey: receiptKey(receipt.id),
        caseId: facts.caseId,
        creditApplicationId: receipt.creditApplicationId,
        lines: [
          { accountId: bank, direction: 'debit', amountRial: receipt.amountRial },
          { accountId: held, direction: 'credit', amountRial: receipt.amountRial },
        ],
      },
      tx,
    );
    const [posting] = await tx
      .insert(downPaymentPostings)
      .values({
        receiptId: receipt.id,
        creditApplicationId: receipt.creditApplicationId,
        borrowerPersonId: facts.borrowerPersonId,
        entityId,
        amountRial: receipt.amountRial,
        journalEntryId: journal.id,
        createdBy: actor.accountId ?? receipt.decidedBy ?? receipt.uploadedBy,
      })
      .returning();
    if (!posting) throw new Error('posting insert returned nothing');
    await this.audit.record(
      {
        actor,
        action: 'contract.down_payment_posted',
        entityType: 'completion_receipt',
        entityId: receipt.id,
        after: { journalEntryId: journal.id, amountRial: receipt.amountRial.toString() },
      },
      tx,
    );
    await this.outbox.publish(
      {
        type: 'contract.down_payment_posted',
        aggregateType: 'completion_receipt',
        aggregateId: receipt.id,
        payload: {
          creditApplicationId: receipt.creditApplicationId,
          receiptId: receipt.id,
          journalEntryId: journal.id,
        },
      },
      tx,
    );
    return posting;
  }

  /**
   * ADR-034's retroactive posting: every down payment approved before it (task 4-3) and not
   * posted yet, each in its own transaction. Running it again posts nothing.
   */
  async postMissing(actor: Actor): Promise<{ posted: number; seen: number }> {
    const rows = await this.db
      .select({ id: completionReceipts.id })
      .from(completionReceipts)
      .leftJoin(downPaymentPostings, eq(downPaymentPostings.receiptId, completionReceipts.id))
      .where(
        and(
          eq(completionReceipts.kind, 'down_payment'),
          eq(completionReceipts.status, 'approved'),
          isNull(downPaymentPostings.id),
        ),
      )
      .orderBy(asc(completionReceipts.createdAt));
    let posted = 0;
    for (const { id } of rows) {
      const made = await this.db.transaction(async (tx) => {
        const receipt = await this.lockReceipt(tx, id);
        const [before] = await tx
          .select({ id: downPaymentPostings.id })
          .from(downPaymentPostings)
          .where(eq(downPaymentPostings.receiptId, id));
        await this.post(actor, receipt, tx);
        return before === undefined;
      });
      if (made) posted += 1;
    }
    return { posted, seen: rows.length };
  }

  /**
   * Before funding only: the posting's full opposite (Dr `downpayment.held`, Cr
   * `bank.collection`), by finance with a reason, once (ADR-034). The money's return to the
   * patient is a bank transfer outside this document (TODO(decision), task 4-8).
   */
  async reverse(actor: Actor, access: EffectiveAccess, receiptId: string, reason: string) {
    if (!access.permissions.has('repayment.approve_payment')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    if (!UUID.test(receiptId)) throw notFound();
    const [receipt] = await this.db
      .select()
      .from(completionReceipts)
      .where(eq(completionReceipts.id, receiptId));
    if (!receipt) throw notFound();
    await this.reachable(access, receipt.creditApplicationId);
    return this.db.transaction(async (tx) => {
      const [posting] = await tx
        .select()
        .from(downPaymentPostings)
        .where(eq(downPaymentPostings.receiptId, receiptId))
        .for('update');
      if (!posting) throw new ConflictException({ error: 'not_posted' });
      if (posting.reversalJournalEntryId) return postingView(posting);
      if (posting.fundedPurseId) throw new ConflictException({ error: 'already_funded' });
      // Task 4-8: refunded to the borrower on a cancellation; there is nothing held to reverse.
      if (await this.refunded(receiptId, tx)) throw new ConflictException({ error: 'refunded' });
      const reversal = await this.ledger.reverseJournal(
        actor,
        posting.journalEntryId,
        { idempotencyKey: `${receiptKey(receiptId)}:reverse`, reason },
        tx,
      );
      const [done] = await tx
        .update(downPaymentPostings)
        .set({
          reversalJournalEntryId: reversal.id,
          reversalReason: reason,
          reversedBy: actor.accountId,
          reversedAt: new Date(),
        })
        .where(eq(downPaymentPostings.id, posting.id))
        .returning();
      if (!done) throw new Error('posting update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'contract.down_payment_reversed',
          entityType: 'completion_receipt',
          entityId: receiptId,
          before: { journalEntryId: posting.journalEntryId },
          after: { reversalJournalEntryId: reversal.id },
          reason,
        },
        tx,
      );
      await this.outbox.publish(
        {
          type: 'contract.down_payment_reversed',
          aggregateType: 'completion_receipt',
          aggregateId: receiptId,
          payload: {
            creditApplicationId: posting.creditApplicationId,
            receiptId,
            journalEntryId: reversal.id,
          },
        },
        tx,
      );
      return postingView(done);
    });
  }

  // --- COMPLETION_STATUS ------------------------------------------------------------

  async completedAt(creditApplicationId: string): Promise<Date | null> {
    if (!UUID.test(creditApplicationId)) return null;
    const [row] = await this.db
      .select({ completedAt: caseCompletions.completedAt })
      .from(caseCompletions)
      .where(eq(caseCompletions.creditApplicationId, creditApplicationId));
    return row?.completedAt ?? null;
  }

  async lockForFunding(
    actor: Actor,
    creditApplicationId: string,
    executor: SqlExecutor,
  ): Promise<FundingReadiness> {
    // The funding transaction of the wallet module: the same Drizzle transaction.
    const tx = executor as Tx;
    // Not locked: a completion is one row per application (unique index), never updated or
    // deleted (trigger; the app role has only SELECT and INSERT). The only change a reader
    // can miss is its insert, which makes funding refuse, never fund wrongly. FOR SHARE
    // would also need an UPDATE grant the table rightly has none of.
    const [completion] = await tx
      .select({ completedAt: caseCompletions.completedAt })
      .from(caseCompletions)
      .where(eq(caseCompletions.creditApplicationId, creditApplicationId));
    const [contract] = await tx
      .select({ entityId: contracts.entityId })
      .from(contracts)
      .where(
        and(eq(contracts.creditApplicationId, creditApplicationId), ne(contracts.status, 'failed')),
      )
      .for('share');
    const base = {
      creditApplicationId,
      completedAt: completion?.completedAt ?? null,
      entityId: contract?.entityId ?? null,
    };
    const [receipt] = await tx
      .select()
      .from(completionReceipts)
      .where(
        and(
          eq(completionReceipts.creditApplicationId, creditApplicationId),
          eq(completionReceipts.kind, 'down_payment'),
          eq(completionReceipts.status, 'approved'),
        ),
      )
      .for('update');
    if (!receipt) return { ...base, downPayment: null, problem: null };
    const posting = await this.post(actor, receipt, tx);
    const held = await this.heldAccount(posting.entityId, posting.borrowerPersonId, tx);
    const downPayment = {
      postingId: posting.id,
      journalEntryId: posting.journalEntryId,
      amountRial: posting.amountRial,
      heldAccountId: held,
    };
    const problem = posting.reversalJournalEntryId
      ? 'down_payment_reversed'
      : posting.fundedPurseId
        ? 'down_payment_funded'
        : (await this.refunded(receipt.id, tx))
          ? 'down_payment_refunded'
          : null;
    return { ...base, downPayment, problem };
  }

  async markDownPaymentFunded(
    postingId: string,
    purseId: string,
    at: Date,
    executor: SqlExecutor,
  ): Promise<void> {
    const tx = executor as Tx;
    const done = await tx
      .update(downPaymentPostings)
      .set({ fundedPurseId: purseId, fundedAt: at })
      .where(
        and(
          eq(downPaymentPostings.id, postingId),
          isNull(downPaymentPostings.fundedPurseId),
          isNull(downPaymentPostings.reversalJournalEntryId),
        ),
      )
      .returning({ id: downPaymentPostings.id });
    if (done.length !== 1) throw new ConflictException({ error: 'down_payment_not_fundable' });
  }

  // --- reconciliation ---------------------------------------------------------------

  /**
   * The contract module's own check (ADR-034): every approved receipt has exactly one
   * posting of its own amount (a fee's on its row, a down payment's in the link table).
   * Read only. The ledger side (bank.collection) is the ledger's reconciliation.
   */
  async receiptsWithoutPosting(): Promise<string[]> {
    const rows = await this.db.execute(sql`
      SELECT r.id FROM completion_receipts r
      LEFT JOIN down_payment_postings p ON p.receipt_id = r.id
      WHERE r.status = 'approved' AND (
        (r.kind <> 'down_payment' AND r.journal_entry_id IS NULL)
        OR (r.kind = 'down_payment' AND (p.id IS NULL OR p.amount_rial <> r.amount_rial))
      )
      ORDER BY r.created_at
    `);
    return rows.rows.map((r) => r['id'] as string);
  }

  // --- helpers ----------------------------------------------------------------------

  /** Whether a receipt was refunded on a cancellation before funding (task 4-8). */
  private async refunded(receiptId: string, tx: Tx): Promise<boolean> {
    const found = await tx.execute(
      sql`SELECT 1 FROM completion_refunds WHERE receipt_id = ${receiptId}`,
    );
    return found.rows.length > 0;
  }

  private async lockReceipt(tx: Tx, id: string): Promise<ReceiptRow> {
    const [row] = await tx
      .select()
      .from(completionReceipts)
      .where(eq(completionReceipts.id, id))
      .for('update');
    if (!row) throw notFound();
    return row;
  }

  async entityOf(creditApplicationId: string, tx: Tx): Promise<string> {
    const [contract] = await tx
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

  private async bankAccount(entityId: string, tx: Tx): Promise<string> {
    return (
      await this.ledger.openAccount(
        {
          entityId,
          code: 'bank.collection',
          name: 'حساب دریافت اقساط',
          kind: 'asset',
          ownerType: 'company',
          ownerId: null,
        },
        tx,
      )
    ).id;
  }

  /** ADR-034: what Aramesh holds of this borrower's down payments until funding. */
  async heldAccount(entityId: string, borrowerPersonId: string, tx: Tx): Promise<string> {
    return (
      await this.ledger.openAccount(
        {
          entityId,
          code: 'downpayment.held',
          name: 'پیش‌پرداخت نزد آرامش',
          kind: 'liability',
          ownerType: 'borrower',
          ownerId: borrowerPersonId,
        },
        tx,
      )
    ).id;
  }

  private async reachable(access: EffectiveAccess, creditApplicationId: string) {
    const facts = await this.credit.facts(creditApplicationId);
    if (!facts) throw notFound();
    if (access.scopes.some((s) => s.kind === 'global')) return facts;
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    const proforma = await this.proformas.proforma(facts.proformaId);
    if (!proforma || !cities.includes(proforma.cityCode)) throw notFound();
    return facts;
  }
}

function postingView(p: PostingRow) {
  return {
    receiptId: p.receiptId,
    creditApplicationId: p.creditApplicationId,
    amountRial: p.amountRial.toString(),
    journalEntryId: p.journalEntryId,
    funded: p.fundedPurseId !== null,
    reversed: p.reversalJournalEntryId !== null,
    reversedAt: p.reversedAt?.toISOString() ?? null,
  };
}
