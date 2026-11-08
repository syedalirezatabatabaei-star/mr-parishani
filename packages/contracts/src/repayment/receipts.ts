import * as z from 'zod';
import { rialAmountSchema } from '../catalog/tariffs.js';

/**
 * Payment slips (task 6-2 [financial]; doc 15 §2; owner 1405/07/15): on phase 1's payments,
 * the borrower's upload, a flag when a slip looks like one already received, the two kinds
 * of rejection, and what stays in suspense.
 */

/** Where a payment came from: entered by staff (phase 1), a borrower's slip, a bank file. */
export const PAYMENT_CHANNELS = ['staff', 'manual_receipt', 'bank_statement'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

/**
 * not_received: the money never came; the pending posting is reversed exactly.
 * received_unaccepted: it came but is not accepted; it stays in suspense until accounting
 * decides (by two people, a later task).
 */
export const PAYMENT_REJECT_KINDS = ['not_received', 'received_unaccepted'] as const;
export type PaymentRejectKind = (typeof PAYMENT_REJECT_KINDS)[number];

/** A bank's tracking number as compared: Latin digits, without spaces or separators. */
export function normalizeBankRef(ref: string): string {
  const latin = ref
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return latin.replace(/[\s\-_/.]/g, '').toUpperCase();
}

export const uploadRepaymentReceiptSchema = z.strictObject({
  scheduleId: z.uuid(),
  amountRial: rialAmountSchema,
  /** Gregorian day the transfer was made (YYYY-MM-DD); the UI takes it in Jalali. */
  paidOn: z.iso.date(),
  bankRef: z.string().trim().min(3).max(60),
  payerName: z.string().trim().min(2).max(120),
});

export const approvePaymentSchema = z
  .strictObject({
    /** A flagged slip is approved only when someone says it is not a duplicate, and why. */
    notDuplicate: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  // Phase 1's approval takes no body.
  .optional()
  .default({});

export const rejectPaymentSchema = z.strictObject({
  /** Phase 1's rejection had no kind: the money stays in suspense, as it did. */
  kind: z.enum(PAYMENT_REJECT_KINDS).default('received_unaccepted'),
  reason: z.string().trim().min(3).max(500),
});

const instant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const paymentQueueRowSchema = z.object({
  id: z.uuid(),
  scheduleId: z.uuid(),
  caseId: z.uuid(),
  amountRial: rial,
  receivedAt: instant,
  paidOn: z.string().nullable(),
  bankRef: z.string().nullable(),
  payerName: z.string().nullable(),
  channel: z.enum(PAYMENT_CHANNELS),
  status: z.enum(['pending_approval', 'approved', 'rejected']),
  rejectKind: z.enum(PAYMENT_REJECT_KINDS).nullable(),
  /** The slip this one looks the same as (bank ref, amount, day): a warning. */
  suspectedDuplicateOf: z.uuid().nullable(),
  hasImage: z.boolean(),
});
export type PaymentQueueRow = z.infer<typeof paymentQueueRowSchema>;

export const paymentQueueQuerySchema = z.object({
  status: z.enum(['pending_approval', 'approved', 'rejected']).optional(),
});

/** What a schedule holds in suspense.unallocated, and why (owner: reported, not moved). */
export const suspenseRowSchema = z.object({
  scheduleId: z.uuid(),
  caseId: z.uuid(),
  unallocatedRial: rial,
  /** Of it: approved payments beyond the debt. */
  surplusRial: rial,
  /** Of it: received but not accepted. */
  rejectedReceivedRial: rial,
  /** Of it: slips waiting for approval. */
  pendingRial: rial,
});
export type SuspenseRow = z.infer<typeof suspenseRowSchema>;

export const receiptLinkSchema = z.object({ url: z.string(), expiresInSeconds: z.int() });
