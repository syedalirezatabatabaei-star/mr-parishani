import * as z from 'zod';

/**
 * Credit transfer to an AuthorizedRecipient (task 4-8 [financial], part 5; doc 12 §7, §9
 * test 11; owner 1405/07/14, س۳ to س۹). No money moves: the debt stays with the borrower;
 * the recipient's mobile gets the service codes, up to the transfer's amount. Asked by case
 * completion or accounting with a code to the recipient's mobile and one to the borrower's
 * (consent), then approved by another person in accounting. Revoked by the borrower in the
 * portal, or by two people in finance. Behind its flag. Amounts are whole rials as text.
 */

export const CREDIT_TRANSFER_STATUSES = [
  'awaiting_codes',
  'requested',
  'approved',
  'rejected',
  'revoke_requested',
  'revoked',
] as const;
export type CreditTransferStatus = (typeof CREDIT_TRANSFER_STATUSES)[number];

const rial = z.string().regex(/^[1-9]\d{0,17}$/);
const reason = z.string().trim().min(3).max(500);
const code = z.string().trim().min(4).max(10);

export const requestCreditTransferSchema = z.strictObject({
  purseId: z.uuid(),
  recipient: z.strictObject({
    name: z.string().trim().min(2).max(120),
    /** Any digits; normalized and checked (its check digit) before it is stored. */
    nationalId: z.string().trim().min(10).max(12),
    mobile: z.string().trim().min(10).max(14),
  }),
  amountRial: rial,
  reason,
  /** ADR-047: the number of the paper the borrower signed for this transfer. */
  paperDocumentNumber: z.string().trim().min(1).max(64),
});
export type RequestCreditTransfer = z.infer<typeof requestCreditTransferSchema>;

/** The two codes, read to the staff member by the recipient and the borrower (owner س۴). */
export const creditTransferCodesSchema = z.strictObject({
  recipientCode: code,
  borrowerCode: code,
});

export const decideCreditTransferSchema = z.strictObject({ reason });

/** ADR-047: approving says the signed paper was received. */
export const approveCreditTransferSchema = z.strictObject({
  reason,
  paperReceived: z.boolean(),
});

export const creditTransferQuerySchema = z.object({
  purseId: z.uuid().optional(),
  status: z.enum(CREDIT_TRANSFER_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });

export const creditTransferViewSchema = z.object({
  id: z.uuid(),
  purseId: z.uuid(),
  status: z.enum(CREDIT_TRANSFER_STATUSES),
  /** The recipient's name and the last four digits of their mobile; never the national ID. */
  recipientName: z.string().nullable(),
  recipientMobileLast4: z.string().nullable(),
  amountRial: z.string(),
  reason: z.string(),
  /** ADR-047: the signed paper's number, and when finance confirmed receiving it. */
  paperDocumentNumber: z.string().nullable(),
  paperReceivedAt: instant.nullable(),
  requestedAt: instant,
  /** A request is never approved by who asked it. */
  requestedByMe: z.boolean(),
  recipientVerifiedAt: instant.nullable(),
  borrowerConsentedAt: instant.nullable(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
  revokeRequestedAt: instant.nullable(),
  revokeRequestedByMe: z.boolean(),
  revokeReason: z.string().nullable(),
  revokedAt: instant.nullable(),
  revokedVia: z.enum(['borrower', 'finance']).nullable(),
});
export type CreditTransferView = z.infer<typeof creditTransferViewSchema>;

/** The borrower's view of a transfer of their own purse, in the portal. */
export const myCreditTransferViewSchema = z.object({
  id: z.uuid(),
  purseId: z.uuid(),
  status: z.enum(CREDIT_TRANSFER_STATUSES),
  recipientName: z.string().nullable(),
  amountRial: z.string(),
  decidedAt: instant.nullable(),
  revokedAt: instant.nullable(),
});
export type MyCreditTransferView = z.infer<typeof myCreditTransferViewSchema>;

export const revokeMyCreditTransferSchema = z.strictObject({ reason: reason.optional() });
