import * as z from 'zod';
import { rialAmountSchema } from '../catalog/tariffs.js';

/**
 * Case completion and its receipts (doc 12 §4; task 4-3). A credit application is
 * completed when its contract is accepted, its delivery checked, its conditions ticked and
 * every receipt it owes approved by finance. Receipts come through the PaymentProvider of
 * ADR-009, the manual receipt of version one.
 */

/** What a receipt pays (owner, 1405/07/11: the down payment goes to Aramesh Sarvat). */
export const COMPLETION_RECEIPT_KINDS = ['origination_fee', 'plan_fee', 'down_payment'] as const;
export type CompletionReceiptKind = (typeof COMPLETION_RECEIPT_KINDS)[number];

export const COMPLETION_RECEIPT_STATUSES = ['pending_approval', 'approved', 'rejected'] as const;

/** The non-file fields of a receipt upload (multipart, with `file`). */
export const uploadCompletionReceiptSchema = z.strictObject({
  kind: z.enum(COMPLETION_RECEIPT_KINDS),
  amountRial: rialAmountSchema,
  /** Gregorian day the payment was made (YYYY-MM-DD); the UI takes it in Jalali. */
  paidOn: z.iso.date(),
  /** The bank's tracking number of the transfer. */
  reference: z.string().trim().min(3).max(60),
});

export const rejectCompletionReceiptSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

const instant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const completionReceiptViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  kind: z.enum(COMPLETION_RECEIPT_KINDS),
  amountRial: rial,
  expectedRial: rial,
  paidOn: z.string(),
  reference: z.string(),
  status: z.enum(COMPLETION_RECEIPT_STATUSES),
  rejectionReason: z.string().nullable(),
  journalEntryId: z.uuid().nullable(),
  createdAt: instant,
  decidedAt: instant.nullable(),
});
export type CompletionReceiptView = z.infer<typeof completionReceiptViewSchema>;

/**
 * ADR-048: an officer's discount on the origination fee (the annex's note 2), under their own
 * signature, with no second person (owner). The non-file fields of the multipart upload.
 */
export const grantOriginationDiscountSchema = z.strictObject({
  /** In bps of the fee's base: 100 is 1% (at most the plan's `originationOfficerDiscountBps`). */
  discountBps: z.coerce.number().int().min(1).max(10_000),
  reason: z.string().trim().min(3).max(500),
});
export type GrantOriginationDiscount = z.input<typeof grantOriginationDiscountSchema>;

export const originationDiscountViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  discountBps: z.int(),
  grantedBy: z.uuid(),
  /** The officer's display name, for the monthly list. */
  grantedByName: z.string().nullable(),
  reason: z.string(),
  createdAt: instant,
});
export type OriginationDiscountView = z.infer<typeof originationDiscountViewSchema>;

/**
 * ADR-048: the origination fee owed now: the fee, its base, the borrower's checked cheques, the
 * waiver and discount applied, and the net. `locked` once a receipt was uploaded for it (or the
 * application completed with nothing to pay): later cheques or discounts change nothing then.
 */
export const originationOwedSchema = z.object({
  feeRial: rial,
  baseRial: rial,
  chequeCount: z.int().nonnegative(),
  /** The plan's cheque count for its waiver; null: the plan has no waiver (six months). */
  minCheques: z.int().nullable(),
  waiverBps: z.int().nonnegative(),
  discountBps: z.int().nonnegative(),
  /** The most an officer may still grant; 0 when the plan has none, or once one is given. */
  maxDiscountBps: z.int().nonnegative(),
  netRial: rial,
  locked: z.boolean(),
  /** Staff only (the patient sees the amounts, not who granted it). */
  discount: originationDiscountViewSchema.nullable(),
});
export type OriginationOwed = z.infer<typeof originationOwedSchema>;

/**
 * `GET /origination-discounts/candidates?mobile=…` (owner 1405/08/02, plan item ب): the club
 * officer finds a person's applications whose origination fee may still take a discount. No
 * name, score, decision reason or treatment detail: only what the discount needs.
 */
export const originationDiscountCandidatesQuerySchema = z.strictObject({
  mobile: z.string().trim().min(10).max(20),
});

export const originationDiscountCandidateSchema = z.object({
  creditApplicationId: z.uuid(),
  planTitle: z.string(),
  origination: originationOwedSchema,
});
export type OriginationDiscountCandidate = z.infer<typeof originationDiscountCandidateSchema>;

/** `GET /origination-discounts?month=1405-07`: a Jalali month's discounts (accounting). */
export const originationDiscountsQuerySchema = z.strictObject({
  month: z.string().regex(/^1[34]\d{2}-(0[1-9]|1[0-2])$/),
});

export const originationDiscountReportRowSchema = originationDiscountViewSchema.extend({
  /** The reduction it made, once locked with a receipt or at completion; else null. */
  reductionRial: rial.nullable(),
});
export type OriginationDiscountReportRow = z.infer<typeof originationDiscountReportRowSchema>;

/** Where an application stands on each condition of completion (doc 12 §4). */
export const completionStatusSchema = z.object({
  creditApplicationId: z.uuid(),
  completedAt: instant.nullable(),
  contractAccepted: z.boolean(),
  deliveryVerified: z.boolean(),
  conditions: z.array(
    z.object({ index: z.int().nonnegative(), text: z.string(), checkedAt: instant.nullable() }),
  ),
  /** Each receipt the application owes, by kind, and the amount owed. */
  owed: z.array(
    z.object({
      kind: z.enum(COMPLETION_RECEIPT_KINDS),
      expectedRial: rial,
      approved: z.boolean(),
    }),
  ),
  receipts: z.array(completionReceiptViewSchema),
  /** ADR-048: the origination fee's breakdown; null when the application owes none. */
  origination: originationOwedSchema.nullable(),
  /** What still stands in the way; empty when it may be completed. */
  missing: z.array(z.string()),
});
export type CompletionStatus = z.infer<typeof completionStatusSchema>;

/** A down payment's posting (ADR-034): made at approval; funded, or reversed before funding. */
export const downPaymentPostingViewSchema = z.object({
  receiptId: z.uuid(),
  creditApplicationId: z.uuid(),
  amountRial: rial,
  journalEntryId: z.uuid(),
  funded: z.boolean(),
  reversed: z.boolean(),
  reversedAt: instant.nullable(),
});
