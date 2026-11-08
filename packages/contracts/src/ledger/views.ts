import * as z from 'zod';

/**
 * What the ledger's read routes answer (task 1-1, 1-4). Owner 1405/07/26: the schemas only
 * describe; nothing in the ledger changed. Amounts are strings of rials: JSON has no bigint.
 */
const rial = z.string().regex(/^\d+$/);
/** A net balance: below zero for an account on the credit side. */
const signedRial = z.string().regex(/^-?\d+$/);
const instant = z.iso.datetime({ offset: true });

export const accountBalanceSchema = z.object({
  accountId: z.uuid(),
  debitRial: rial,
  creditRial: rial,
  netDebitRial: signedRial,
});
export type AccountBalanceView = z.infer<typeof accountBalanceSchema>;

export const journalViewSchema = z.object({
  id: z.uuid(),
  entityId: z.string(),
  /** Open: a new event type of a module must not break the reading. */
  eventType: z.string(),
  occurredAt: instant,
  caseId: z.uuid().nullable(),
  creditApplicationId: z.uuid().nullable(),
  reversesJournalEntryId: z.uuid().nullable(),
  reason: z.string().nullable(),
  /** Null for a document written by the system. */
  createdBy: z.uuid().nullable(),
  createdAt: instant,
  lines: z.array(
    z.object({
      id: z.uuid(),
      accountId: z.uuid(),
      direction: z.enum(['debit', 'credit']),
      amountRial: rial,
    }),
  ),
});
export type JournalView = z.infer<typeof journalViewSchema>;

/** One nightly reconciliation run (task 1-4): read straight from SQL, so held by this. */
export const reconciliationRunSchema = z.object({
  id: z.uuid(),
  startedAt: instant,
  clean: z.boolean(),
  accountsChecked: z.int().nonnegative(),
  journalsApplied: z.int().nonnegative(),
  mismatches: z.int().nonnegative(),
  invariantViolations: z.int().nonnegative(),
  unbalancedEntities: z.int().nonnegative(),
  overdueUnapplied: z.int().nonnegative(),
  discrepancies: z.array(
    z.object({
      kind: z.enum(['balance_mismatch', 'negative_balance']),
      accountId: z.uuid(),
      expectedDebitRial: rial,
      expectedCreditRial: rial,
      actualDebitRial: rial,
      actualCreditRial: rial,
    }),
  ),
  reports: z.array(
    z.object({
      entityId: z.string(),
      reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dayDebitRial: rial,
      dayCreditRial: rial,
      totalDebitRial: rial,
      totalCreditRial: rial,
      balanced: z.boolean(),
    }),
  ),
});
export type ReconciliationRunView = z.infer<typeof reconciliationRunSchema>;
