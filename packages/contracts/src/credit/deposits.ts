import * as z from 'zod';

/**
 * The formation deposit (بیعانه تشکیل; owner 1405/07/29, answer f): in the pilot only its
 * details are recorded, with no ledger row; the `deposit.held` account comes after the pilot
 * with its own ADR. Its amount is the business number `credit.formation_deposit_rial` (0 = off),
 * locked on the record with its configuration version (rule 16). It is not refunded once the
 * introduction letter is issued; TODO(decision): the system has no such letter, so the
 * default is the purse's charge, the line it already draws for the origination fee (owner
 * 4.7).
 */

/** The bank's tracking number of the transfer, as for a completion receipt. */
const reference = z.string().trim().min(3).max(60);

export const recordFormationDepositSchema = z.strictObject({
  /** Gregorian day the deposit was paid (YYYY-MM-DD); the UI takes it in Jalali. */
  paidOn: z.iso.date(),
  bankReference: reference,
  note: z.string().trim().max(500).optional(),
});
export type RecordFormationDeposit = z.input<typeof recordFormationDepositSchema>;

export const recordFormationDepositRefundSchema = z.strictObject({
  refundedOn: z.iso.date(),
  refundReference: reference,
  reason: z.string().trim().min(3).max(500),
});
export type RecordFormationDepositRefund = z.input<typeof recordFormationDepositRefundSchema>;

const instant = z.iso.datetime({ offset: true });

export const formationDepositViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  /** Locked from the configuration on recording; whole rials as a string. */
  amountRial: z.string().regex(/^\d+$/),
  paidOn: z.string(),
  /** Only the last four characters (rule 30 spirit: what the panel needs). */
  bankReferenceLast4: z.string(),
  note: z.string().nullable(),
  recordedAt: instant,
  refund: z
    .object({
      refundedOn: z.string(),
      refundReferenceLast4: z.string(),
      reason: z.string(),
      recordedAt: instant,
    })
    .nullable(),
  /** False once the purse is charged (the introduction letter's default) or after a refund. */
  refundable: z.boolean(),
});
export type FormationDepositView = z.infer<typeof formationDepositViewSchema>;

/** `GET …/formation-deposit`: the deposit, if recorded, and what the configuration asks now. */
export const formationDepositStateSchema = z.object({
  deposit: formationDepositViewSchema.nullable(),
  /** The amount in force now; "0" means deposits are off. */
  configuredAmountRial: z.string().regex(/^\d+$/),
});
export type FormationDepositState = z.infer<typeof formationDepositStateSchema>;

/**
 * ADR-050: a wage-only application's split of wage and materials, checked once by credit or
 * case completion before its decision, with a note.
 */
export const recordCostSplitReviewSchema = z.strictObject({
  note: z.string().trim().min(3).max(500),
});
export type RecordCostSplitReview = z.input<typeof recordCostSplitReviewSchema>;

export const costSplitStateSchema = z.object({
  /** False for an application on a plan financing everything: nothing to check. */
  wageOnly: z.boolean(),
  /** The proforma's wage lines and its materials, as locked on the application. */
  wageRial: z.string().regex(/^\d+$/).nullable(),
  materialCashRial: z.string().regex(/^\d+$/),
  review: z.object({ reviewedBy: z.uuid(), note: z.string(), reviewedAt: instant }).nullable(),
});
export type CostSplitState = z.infer<typeof costSplitStateSchema>;
