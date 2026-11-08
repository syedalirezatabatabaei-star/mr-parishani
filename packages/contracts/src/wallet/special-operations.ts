import * as z from 'zod';

/**
 * Special operations on a credit purse (doc 12 §7; task 4-8 [financial]): asked by one
 * person in finance, decided by another (two people for anything that moves money). Part 1:
 * cancelling what is unused, all or part (ADR-034's order; the loan's part off the debt and
 * the last installments, the down payment's to refund), and reversing such a cancellation.
 * Amounts are whole rials as text (rule 1).
 */

export const SPECIAL_OPERATION_KINDS = [
  'cancel_unused',
  'reverse_cancel_unused',
  'change_doctor',
  'cancel_after_funding',
] as const;
export type SpecialOperationKind = (typeof SPECIAL_OPERATION_KINDS)[number];
export const SPECIAL_OPERATION_STATUSES = ['requested', 'approved', 'rejected'] as const;
export type SpecialOperationStatus = (typeof SPECIAL_OPERATION_STATUSES)[number];

const rial = z.string().regex(/^[1-9]\d{0,17}$/);
const reason = z.string().trim().min(3).max(500);

export const requestSpecialOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cancel_unused'),
    purseId: z.uuid(),
    /** Absent: everything unused. */
    amountRial: rial.optional(),
    reason,
  }),
  z.strictObject({
    kind: z.literal('change_doctor'),
    purseId: z.uuid(),
    /** The new doctor's workplace (doc 12 §7; owner پ۲: no Referral). */
    workplaceId: z.uuid(),
    reason,
  }),
  z.strictObject({
    /** Doc 02 §6 (part 7): what is unused, the fee of installments not yet due, a penalty. */
    kind: z.literal('cancel_after_funding'),
    purseId: z.uuid(),
    reason,
  }),
  z.strictObject({
    kind: z.literal('reverse_cancel_unused'),
    /** The approved cancellation to reverse. */
    requestId: z.uuid(),
    reason,
  }),
]);
export type RequestSpecialOperation = z.infer<typeof requestSpecialOperationSchema>;

export const decideSpecialOperationSchema = z.strictObject({ reason });

/**
 * The doctors a purse may move to (f7, owner 1405/07/23, plan 2): a read for the «new
 * doctor» picker. A name or center to look for; the panel normalizes it (rule 23) and so
 * does the API.
 */
export const doctorCandidatesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
});
/** Strict (owner 1405/07/26): no other field of the doctor, no number of theirs, ever. */
export const doctorCandidateSchema = z.strictObject({
  workplaceId: z.uuid(),
  /** Treatment data (doc 04 §4): only for whoever holds access.view_treatment. */
  doctorName: z.string(),
  /** Owner 1405/07/24: the center's name only. Null for a private practice. */
  centerName: z.string().nullable(),
});
export type DoctorCandidate = z.infer<typeof doctorCandidateSchema>;
export const specialOperationQuerySchema = z.object({
  purseId: z.uuid().optional(),
  status: z.enum(SPECIAL_OPERATION_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });

export const specialOperationViewSchema = z.object({
  id: z.uuid(),
  purseId: z.uuid(),
  kind: z.enum(SPECIAL_OPERATION_KINDS),
  status: z.enum(SPECIAL_OPERATION_STATUSES),
  /** What is asked to be cancelled; null: everything unused. */
  amountRial: z.string().nullable(),
  /** For a reversal: the cancellation it reverses. */
  reversesRequestId: z.uuid().nullable(),
  /** For a doctor change: the new doctor's workplace. */
  workplaceId: z.uuid().nullable(),
  reason: z.string(),
  requestedAt: instant,
  /** A request is never decided by who asked it. */
  requestedByMe: z.boolean(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
  /**
   * Once done. A cancellation: what was cancelled, split by part, and the schedule's new
   * revision. A doctor change: the scope's new version and the authorizations it cancelled.
   */
  result: z
    .object({
      amountRial: z.string().optional(),
      loanRial: z.string().optional(),
      downPaymentRial: z.string().optional(),
      operationId: z.uuid().optional(),
      revisionId: z.uuid().nullable().optional(),
      versionId: z.uuid().optional(),
      cancelledAuthorizations: z.int().min(0).optional(),
      /** Cancelling after funding: the plan fee waived, the penalty and its due day. */
      feeWaivedRial: z.string().optional(),
      feeRevisionId: z.uuid().nullable().optional(),
      /** ADR-045: the unearned part of a plan fee paid in cash at completion, owed back. */
      planFeeRefundRial: z.string().optional(),
      planFeeRefundJournalId: z.uuid().nullable().optional(),
      penaltyRial: z.string().optional(),
      penaltyRateBps: z.int().optional(),
      penaltyDueOn: z.iso.date().nullable().optional(),
      chargeId: z.uuid().nullable().optional(),
      closed: z.boolean().optional(),
    })
    .nullable(),
});
export type SpecialOperationView = z.infer<typeof specialOperationViewSchema>;
