import * as z from 'zod';

/**
 * Payout orders of an approved statement (task 5-5 [financial]; doc 06 §5; doc 14 ث; owner
 * 1405/07/14): one per center, to the center's Sheba as it was when issued. Sent to the bank in
 * a CSV file, paid when the bank's tracking number is recorded by one person and confirmed by
 * another; a failed order is reissued.
 */

export const PAYOUT_STATUSES = ['issued', 'sent_to_bank', 'confirmed', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const payoutQuerySchema = z.object({
  statementId: z.uuid().optional(),
  status: z.enum(PAYOUT_STATUSES).optional(),
});

export const exportPayoutsSchema = z.strictObject({
  /** Only these issued orders; all issued ones when left out. */
  payoutIds: z.array(z.uuid()).min(1).max(500).optional(),
});

export const recordTrackingSchema = z.strictObject({
  bankTrackingRef: z.string().trim().min(4).max(64),
  /** Gregorian day (YYYY-MM-DD) of the Tehran day it was paid. */
  paidOn: z.iso.date(),
});

export const payoutReasonSchema = z.strictObject({
  reason: z.string().trim().min(3).max(1000),
});

const instant = z.iso.datetime({ offset: true });

export const payoutViewSchema = z.object({
  id: z.uuid(),
  statementId: z.uuid(),
  centerId: z.uuid(),
  amountRial: z.string(),
  ibanLast4: z.string(),
  accountHolder: z.string().nullable(),
  status: z.enum(PAYOUT_STATUSES),
  issuedAt: instant,
  exportBatchId: z.uuid().nullable(),
  bankTrackingRef: z.string().nullable(),
  paidOn: z.string().nullable(),
  trackingRecordedByMe: z.boolean(),
  confirmedAt: instant.nullable(),
  journalEntryId: z.uuid().nullable(),
  failureReason: z.string().nullable(),
  failRequestedByMe: z.boolean(),
  failedAt: instant.nullable(),
  replacesPayoutId: z.uuid().nullable(),
});
export type PayoutView = z.infer<typeof payoutViewSchema>;

/** A bank file: the Sheba in full only here (rule 27), for the bank's portal. */
export const payoutExportSchema = z.object({
  batchId: z.uuid(),
  count: z.int(),
  totalRial: z.string(),
  csv: z.string(),
});
export type PayoutExport = z.infer<typeof payoutExportSchema>;
