import * as z from 'zod';
import { DISPUTE_STATUSES } from './disputes.js';
import { STATEMENT_STATUSES } from './statements.js';

/**
 * The doctor's settlement panel (task 5-6; doc 06 §6): only what their scope covers (rule
 * 13). Amounts are rials as text; the page shows tomans and Jalali days (rules 2, 21).
 */

const instant = z.iso.datetime({ offset: true });
const rial = z.string();

/** A payable or fee not yet in a statement: when it falls due, and what it is. */
export const upcomingItemSchema = z.object({
  kind: z.enum(['credit_service', 'cash_fee']),
  /** The payable (a credit service) or the cash fee: what a dispute is opened on. */
  itemId: z.uuid(),
  subjectType: z.enum(['doctor_payable', 'service_fee']),
  amountRial: rial,
  /** The fee on a credit service; for a cash fee, the fee itself is the amount. */
  feeRial: rial,
  status: z.enum(['accrued', 'due']),
  dueAt: instant,
  /** When it became final (a credit service), or its day (a cash service). */
  occurredAt: instant,
});
export type UpcomingItem = z.infer<typeof upcomingItemSchema>;

export const heldItemSchema = z.object({
  kind: z.enum(['credit_service', 'cash_fee']),
  itemId: z.uuid(),
  amountRial: rial,
  dueAt: instant,
  disputeId: z.uuid().nullable(),
  disputeStatus: z.enum(DISPUTE_STATUSES).nullable(),
  openedAt: instant.nullable(),
});
export type HeldItem = z.infer<typeof heldItemSchema>;

export const panelStatementSchema = z.object({
  id: z.uuid(),
  periodYear: z.int(),
  periodMonth: z.int(),
  status: z.enum(STATEMENT_STATUSES),
  grossCreditServicesRial: rial,
  creditFeesRial: rial,
  cashFeesRial: rial,
  carriedInRial: rial,
  otherDeductionsRial: rial,
  payableRial: rial,
  carriedOutRial: rial,
  generatedAt: instant,
  pdfReady: z.boolean(),
  items: z.array(
    z.object({
      kind: z.enum(['credit_service', 'credit_fee', 'cash_fee']),
      itemId: z.uuid(),
      amountRial: rial,
      occurredAt: instant,
    }),
  ),
});
export type PanelStatement = z.infer<typeof panelStatementSchema>;

export const statementPdfLinkSchema = z.object({ url: z.string(), expiresInSeconds: z.int() });

/** A center's sums per month and doctor (doc 06 §6): never the doctor's items. */
export const centerSummaryRowSchema = z.object({
  periodYear: z.int(),
  periodMonth: z.int(),
  doctorNodeId: z.uuid(),
  /**
   * The doctor's name for their own center (not `doctorName`: that name is the treatment
   * class's, stripped next to a patient, doc 04 §4; no patient is in this row).
   */
  providerName: z.string(),
  statementStatus: z.enum(STATEMENT_STATUSES),
  grossRial: rial,
  feesRial: rial,
  paidRial: rial,
});
export type CenterSummaryRow = z.infer<typeof centerSummaryRowSchema>;
