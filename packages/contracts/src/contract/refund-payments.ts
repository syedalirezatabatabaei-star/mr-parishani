import * as z from 'zod';

/**
 * Paying a refund out by bank (task 4-8 [financial], part 4; ADR-036; owner 1405/07/14):
 * Dr the borrower's `fee.refund_payable` or `downpayment.refund_payable`, Cr
 * `bank.settlement`. Recorded by one person in accounting with the bank's tracking number,
 * approved by another; part of what is owed may be paid, never more than is owed. Amounts
 * are whole rials as text (rule 1).
 */

export const REFUND_ACCOUNTS = ['fee', 'down_payment'] as const;
export type RefundAccount = (typeof REFUND_ACCOUNTS)[number];
export const REFUND_PAYMENT_STATUSES = ['requested', 'approved', 'rejected'] as const;
export type RefundPaymentStatus = (typeof REFUND_PAYMENT_STATUSES)[number];

const rial = z.string().regex(/^[1-9]\d{0,17}$/);
const reason = z.string().trim().min(3).max(500);

export const requestRefundPaymentSchema = z.strictObject({
  creditApplicationId: z.uuid(),
  account: z.enum(REFUND_ACCOUNTS),
  amountRial: rial,
  /** The bank's tracking number; Persian or Arabic digits are taken as Latin. */
  bankReference: z.string().trim().min(4).max(64),
  paidOn: z.iso.date(),
  /** The client's key: the same request sent twice records one (rule 5). */
  idempotencyKey: z.string().min(8).max(200),
  reason,
});
export type RequestRefundPayment = z.infer<typeof requestRefundPaymentSchema>;

export const decideRefundPaymentSchema = z.strictObject({ reason });

export const refundPaymentQuerySchema = z.object({
  creditApplicationId: z.uuid().optional(),
  status: z.enum(REFUND_PAYMENT_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });

export const refundPaymentViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  account: z.enum(REFUND_ACCOUNTS),
  amountRial: z.string(),
  bankReference: z.string(),
  paidOn: z.iso.date(),
  reason: z.string(),
  status: z.enum(REFUND_PAYMENT_STATUSES),
  requestedAt: instant,
  /** A payment is never approved by who recorded it. */
  requestedByMe: z.boolean(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
  journalEntryId: z.uuid().nullable(),
});
export type RefundPaymentView = z.infer<typeof refundPaymentViewSchema>;

/** What Aramesh still owes the borrower of an application, by account. */
export const refundOwedSchema = z.object({
  creditApplicationId: z.uuid(),
  feeRial: z.string(),
  downPaymentRial: z.string(),
});
export type RefundOwed = z.infer<typeof refundOwedSchema>;
