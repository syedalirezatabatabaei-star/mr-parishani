import { CONTRACT_STATUSES } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appendOnlyTimestamps, id, rial, timestamps, timestamptz } from '../../db/columns';

/**
 * Loan contracts (task 4-1, doc 12 §2). The credit application, persons and template are
 * other modules' (ids here). What the template was filled with is a snapshot taken when
 * the contract is asked for; the PDF is printed once by the worker, stored in private
 * space, and its SHA-256 never changes (migration 0030).
 */
export const contracts = pgTable(
  'contracts',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id').notNull(),
    /** The lender (legal_entities, ADR-007): Aramesh Sarvat. */
    entityId: text('entity_id').notNull(),
    jalaliYear: integer('jalali_year').notNull(),
    sequence: integer('sequence').notNull(),
    /** «1405-000001»: per entity and Jalali year (doc 12 §2). */
    number: text('number').notNull(),
    templateVersionId: uuid('template_version_id').notNull(),
    /** The values the template's fields were filled with, as shown (tomans, Jalali). */
    fields: jsonb('fields').$type<Record<string, string>>().notNull(),
    sample: boolean('sample').notNull(),
    /** Who must accept it (doc 12 §2): the borrower and each guarantor of that moment. */
    parties: jsonb('parties')
      .$type<{ role: 'borrower' | 'guarantor'; personId: string; guarantorId: string | null }[]>()
      .notNull(),
    status: text('status', { enum: CONTRACT_STATUSES }).notNull().default('generating'),
    storageKey: text('storage_key'),
    sha256: text('sha256'),
    sizeBytes: integer('size_bytes'),
    failure: text('failure'),
    generatedAt: timestamptz('generated_at'),
    acceptedAt: timestamptz('accepted_at'),
    createdBy: uuid('created_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('contracts_number_key').on(t.entityId, t.number),
    uniqueIndex('contracts_sequence_key').on(t.entityId, t.jalaliYear, t.sequence),
    // One contract per credit application, unless its printing failed.
    uniqueIndex('contracts_application_key')
      .on(t.creditApplicationId)
      .where(sql`${t.status} <> 'failed' AND ${t.deletedAt} IS NULL`),
    index('contracts_application_idx').on(t.creditApplicationId),
  ],
);

/**
 * A party's electronic acceptance (doc 12 §2): with a one-time code, of this contract's
 * text and PDF (its hash). Append-only; one per person and role.
 */
export const contractAcceptances = pgTable(
  'contract_acceptances',
  {
    id: id(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id),
    role: text('role', { enum: ['borrower', 'guarantor'] }).notNull(),
    personId: uuid('person_id').notNull(),
    guarantorId: uuid('guarantor_id'),
    accountId: uuid('account_id').notNull(),
    templateVersionId: uuid('template_version_id').notNull(),
    pdfSha256: text('pdf_sha256').notNull(),
    sessionId: uuid('session_id'),
    ip: text('ip'),
    deviceId: text('device_id'),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('contract_acceptances_party_key').on(t.contractId, t.personId, t.role)],
);

/** The last contract number of each lender and Jalali year (doc 12 §2). */
export const contractNumberSequences = pgTable(
  'contract_number_sequences',
  {
    id: id(),
    entityId: text('entity_id').notNull(),
    jalaliYear: integer('jalali_year').notNull(),
    lastValue: integer('last_value').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('contract_number_sequences_year_key').on(t.entityId, t.jalaliYear),
    check('contract_number_sequences_value_check', sql`${t.lastValue} > 0`),
  ],
);

/**
 * A receipt the application owes before completion (task 4-3; doc 12 §4): the origination
 * fee, the plan fee paid at completion, the down payment (to Aramesh Sarvat). Uploaded by
 * the patient or borrower through the manual PaymentProvider (ADR-009), decided by
 * finance. Approving it posts its journal, except the down payment's (owner, 1405/07/11:
 * no ledger entry for it until 4-5's ADR). Its amount must be exactly the one owed.
 */
export const completionReceipts = pgTable(
  'completion_receipts',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id').notNull(),
    kind: text('kind', { enum: ['origination_fee', 'plan_fee', 'down_payment'] }).notNull(),
    amountRial: rial('amount_rial').notNull(),
    expectedRial: rial('expected_rial').notNull(),
    paidOn: date('paid_on').notNull(),
    reference: text('reference').notNull(),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status', { enum: ['pending_approval', 'approved', 'rejected'] })
      .notNull()
      .default('pending_approval'),
    rejectionReason: text('rejection_reason'),
    /** The ledger document its approval posted (none for the down payment). */
    journalEntryId: uuid('journal_entry_id'),
    uploadedBy: uuid('uploaded_by').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    ...timestamps(),
  },
  (t) => [
    index('completion_receipts_application_idx').on(t.creditApplicationId),
    // One receipt of a kind waiting or approved; a rejected one leaves room for another.
    uniqueIndex('completion_receipts_open_key')
      .on(t.creditApplicationId, t.kind)
      .where(sql`${t.status} IN ('pending_approval', 'approved') AND ${t.deletedAt} IS NULL`),
    uniqueIndex('completion_receipts_storage_key').on(t.storageKey),
    check(
      'completion_receipts_amount_check',
      sql`${t.amountRial} > 0 AND ${t.expectedRial} > 0 AND ${t.sizeBytes} > 0`,
    ),
  ],
);

/**
 * An application's completion (doc 12 §4): recorded once, by case completion, when every
 * condition holds. `completed_at` is an indicator only, never the basis of due dates
 * (doc 02 §5). Append-only.
 */
export const caseCompletions = pgTable(
  'case_completions',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id').notNull(),
    completedBy: uuid('completed_by').notNull(),
    completedAt: timestamptz('completed_at').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('case_completions_application_key').on(t.creditApplicationId)],
);

/**
 * The ledger posting of an approved down-payment receipt (ADR-034; owner, 1405/07/11:
 * a link table, the receipt's own row and rules unchanged). Dr `bank.collection`, Cr
 * `downpayment.held` of the borrower, key `contract:receipt:<receiptId>`, once per receipt.
 * Funding moves it into the purse once (`funded_*`); before funding, finance may reverse
 * it once with the full opposite document (`reversal_*`). Neither is ever undone.
 */
export const downPaymentPostings = pgTable(
  'down_payment_postings',
  {
    id: id(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => completionReceipts.id),
    creditApplicationId: uuid('credit_application_id').notNull(),
    borrowerPersonId: uuid('borrower_person_id').notNull(),
    entityId: text('entity_id').notNull(),
    amountRial: rial('amount_rial').notNull(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    fundedPurseId: uuid('funded_purse_id'),
    fundedAt: timestamptz('funded_at'),
    reversalJournalEntryId: uuid('reversal_journal_entry_id'),
    reversalReason: text('reversal_reason'),
    reversedBy: uuid('reversed_by'),
    reversedAt: timestamptz('reversed_at'),
    createdBy: uuid('created_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('down_payment_postings_receipt_key').on(t.receiptId),
    uniqueIndex('down_payment_postings_journal_key').on(t.journalEntryId),
    uniqueIndex('down_payment_postings_reversal_key').on(t.reversalJournalEntryId),
    index('down_payment_postings_application_idx').on(t.creditApplicationId),
    check('down_payment_postings_amount_check', sql`${t.amountRial} > 0`),
    // Funded or reversed, never both; each all or nothing.
    check(
      'down_payment_postings_state_check',
      sql`((${t.fundedPurseId} IS NULL) = (${t.fundedAt} IS NULL))
        AND ((${t.reversalJournalEntryId} IS NULL) = (${t.reversedAt} IS NULL))
        AND ((${t.reversalJournalEntryId} IS NULL) = (${t.reversalReason} IS NULL))
        AND ((${t.reversalJournalEntryId} IS NULL) = (${t.reversedBy} IS NULL))
        AND (${t.fundedPurseId} IS NULL OR ${t.reversalJournalEntryId} IS NULL)`,
    ),
  ],
);

/**
 * ADR-048: an officer's discount on an application's origination fee (the annex's note 2: a
 * completion or club officer, under their own signature). No second person (owner); the signed
 * file is kept in private space like a receipt. Once per application; append-only.
 */
export const originationDiscounts = pgTable(
  'origination_discounts',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id').notNull(),
    /** In bps of the fee's base; at most the plan's `originationOfficerDiscountBps`. */
    discountBps: integer('discount_bps').notNull(),
    grantedBy: uuid('granted_by').notNull(),
    reason: text('reason').notNull(),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('origination_discounts_application_key').on(t.creditApplicationId),
    uniqueIndex('origination_discounts_storage_key').on(t.storageKey),
    index('origination_discounts_created_idx').on(t.createdAt),
    check(
      'origination_discounts_amount_check',
      sql`${t.discountBps} BETWEEN 1 AND 10000 AND ${t.sizeBytes} > 0`,
    ),
    check('origination_discounts_reason_check', sql`length(trim(${t.reason})) >= 3`),
  ],
);

/**
 * ADR-048: the origination fee owed, locked when its receipt is uploaded (or at completion when
 * the reductions leave nothing to pay): the fee, its base, the waiver and discount applied, the
 * borrower's checked cheques then, and the net. A rejected receipt's row stays; the next upload
 * adds its own. Append-only.
 */
export const originationFeeReductions = pgTable(
  'origination_fee_reductions',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id').notNull(),
    /** Null only when nothing was left to pay, so no receipt was owed. */
    receiptId: uuid('receipt_id').references(() => completionReceipts.id, {
      onDelete: 'restrict',
    }),
    plansVersionId: uuid('plans_version_id').notNull(),
    feeRial: rial('fee_rial').notNull(),
    baseRial: rial('base_rial').notNull(),
    chequeCount: integer('cheque_count').notNull(),
    waiverBps: integer('waiver_bps').notNull(),
    discountId: uuid('discount_id').references(() => originationDiscounts.id, {
      onDelete: 'restrict',
    }),
    discountBps: integer('discount_bps').notNull(),
    netRial: rial('net_rial').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('origination_fee_reductions_receipt_key').on(t.receiptId),
    uniqueIndex('origination_fee_reductions_unpaid_key')
      .on(t.creditApplicationId)
      .where(sql`${t.receiptId} IS NULL`),
    index('origination_fee_reductions_application_idx').on(t.creditApplicationId),
    check(
      'origination_fee_reductions_amount_check',
      sql`${t.feeRial} > 0 AND ${t.baseRial} > 0 AND ${t.netRial} >= 0 AND ${t.netRial} <= ${t.feeRial}
          AND ${t.chequeCount} >= 0 AND ${t.waiverBps} BETWEEN 0 AND 10000
          AND ${t.discountBps} BETWEEN 0 AND 10000`,
    ),
    check(
      'origination_fee_reductions_discount_check',
      sql`(${t.discountBps} > 0) = (${t.discountId} IS NOT NULL)`,
    ),
    check(
      'origination_fee_reductions_unpaid_check',
      sql`${t.receiptId} IS NOT NULL OR ${t.netRial} = 0`,
    ),
  ],
);
