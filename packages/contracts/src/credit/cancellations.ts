import * as z from 'zod';

/**
 * Cancelling a credit application before funding (task 4-8 [financial]; doc 12 §7; owner
 * 1405/07/14): asked by one person, decided by another in accounting. Approving it refunds
 * every approved receipt, without penalty (the origination fee, the plan fee paid at
 * completion, the down payment), and closes the case. Amounts are whole rials as text.
 */

export const CREDIT_CANCELLATION_STATUSES = ['requested', 'approved', 'rejected'] as const;
export type CreditCancellationStatus = (typeof CREDIT_CANCELLATION_STATUSES)[number];

const reason = z.string().trim().min(3).max(500);

export const requestCreditCancellationSchema = z.strictObject({
  creditApplicationId: z.uuid(),
  reason,
});
export type RequestCreditCancellation = z.infer<typeof requestCreditCancellationSchema>;

export const decideCreditCancellationSchema = z.strictObject({ reason });

export const creditCancellationQuerySchema = z.object({
  creditApplicationId: z.uuid().optional(),
  status: z.enum(CREDIT_CANCELLATION_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });

export const creditRefundLineSchema = z.object({
  receiptId: z.uuid(),
  kind: z.enum(['origination_fee', 'plan_fee', 'down_payment']),
  amountRial: z.string(),
  journalEntryId: z.uuid(),
});
export type CreditRefundLine = z.infer<typeof creditRefundLineSchema>;

export const creditCancellationViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  status: z.enum(CREDIT_CANCELLATION_STATUSES),
  reason: z.string(),
  requestedAt: instant,
  /** A request is never decided by who asked it. */
  requestedByMe: z.boolean(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
  /** Once approved: what was refunded, each receipt's amount and its ledger document. */
  refunds: z.array(creditRefundLineSchema).nullable(),
});
export type CreditCancellationView = z.infer<typeof creditCancellationViewSchema>;
