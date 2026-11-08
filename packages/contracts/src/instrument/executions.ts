import * as z from 'zod';

/**
 * Executing a guarantee instrument (task 6-8 [مالی]; doc 15 §6; owner 1405/07/16): a cheque
 * proposed by the collection agent, approved by the collection manager and by finance (three
 * different people), presented, then cleared (its money through 6-2's receipt and allocation,
 * never more than what is owed) or bounced (stage 4: a legal referral). A promissory note is
 * only referred to legal. Instruments are released after full settlement, by accounting.
 * The number of an instrument never appears here: only its last four characters.
 */

export const EXECUTION_STATUSES = [
  'proposed',
  'presented',
  'cleared',
  'bounced',
  'rejected',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const BOUNCE_REASONS = [
  'insufficient_funds',
  'signature_mismatch',
  'account_closed',
  'other',
] as const;
export type BounceReason = (typeof BOUNCE_REASONS)[number];

const reason = z.string().trim().min(3).max(500);

export const proposeExecutionSchema = z.strictObject({ instrumentId: z.uuid(), reason });

/** Who approves as what: needed only by one who holds both approvals' permissions. */
export const approveExecutionSchema = z.strictObject({
  as: z.enum(['collection', 'finance']).optional(),
});

export const rejectExecutionSchema = z.strictObject({ reason });

export const executionClearedSchema = z.strictObject({
  /** The day the bank paid it (YYYY-MM-DD), entered in Jalali by the UI. */
  clearedOn: z.iso.date(),
  /** The bank's tracking number of the credit: never the cheque's own number. */
  bankRef: z.string().trim().min(3).max(60),
});

export const executionBouncedSchema = z
  .strictObject({
    bouncedOn: z.iso.date(),
    reason: z.enum(BOUNCE_REASONS),
    note: z.string().trim().min(3).max(500).optional(),
  })
  .refine((b) => b.reason !== 'other' || b.note !== undefined, {
    message: 'other needs a note',
  });

export const executionQuerySchema = z.object({
  status: z.enum(EXECUTION_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const executionViewSchema = z.object({
  id: z.uuid(),
  instrumentId: z.uuid(),
  caseId: z.uuid(),
  kind: z.enum(['cheque', 'promissory_note']),
  numberLast4: z.string(),
  amountRial: rial,
  dueOn: z.string().nullable(),
  status: z.enum(EXECUTION_STATUSES),
  proposedBy: z.uuid(),
  proposalReason: z.string(),
  proposedAt: instant,
  collectionApprovedBy: z.uuid().nullable(),
  financeApprovedBy: z.uuid().nullable(),
  rejectReason: z.string().nullable(),
  outcomeOn: z.string().nullable(),
  bounceReason: z.enum(BOUNCE_REASONS).nullable(),
  paymentId: z.uuid().nullable(),
});
export type ExecutionView = z.infer<typeof executionViewSchema>;

/** A presented cheque larger than what its loan owes now: clearance refused (owner; 6.10). */
export const executionAlertSchema = z.object({
  executionId: z.uuid(),
  instrumentId: z.uuid(),
  caseId: z.uuid(),
  numberLast4: z.string(),
  amountRial: rial,
  owedRial: rial,
});
export type ExecutionAlert = z.infer<typeof executionAlertSchema>;

/** A held cheque of a case, for the collection agent to propose (task 6-9): last four only. */
export const executionCandidateSchema = z.object({
  instrumentId: z.uuid(),
  kind: z.enum(['cheque', 'promissory_note']),
  role: z.enum(['borrower', 'guarantor']),
  numberLast4: z.string(),
  amountRial: rial,
  dueOn: z.string().nullable(),
});
export const executionCandidatesQuerySchema = z.object({ caseId: z.uuid() });

/** Accounting's live queue: held instruments of loans fully settled (owner: no table). */
export const releaseDueRowSchema = z.object({
  instrumentId: z.uuid(),
  caseId: z.uuid(),
  kind: z.enum(['cheque', 'promissory_note']),
  role: z.enum(['borrower', 'guarantor']),
  numberLast4: z.string(),
  amountRial: rial,
  /** ADR-052: the release asked for and waiting for a second person, if any. */
  pendingRequest: z
    .object({
      id: z.uuid(),
      requestedBy: z.uuid(),
      reason: z.string(),
      requestedAt: instant,
    })
    .nullable(),
});
export type ReleaseDueRow = z.infer<typeof releaseDueRowSchema>;

export const releaseViewSchema = z.object({
  instrumentId: z.uuid(),
  status: z.literal('released'),
  deliveryReleased: z.boolean(),
  smsSent: z.boolean(),
});

/**
 * ADR-052 (owner 1405/08/02): a cheque or promissory note goes back to its owner only with two
 * people, each with their own SMS code: one asks, another approves (or refuses); the asker
 * may withdraw.
 */
export const releaseRequestCreateSchema = z.object({ reason });
export const releaseRequestDecideSchema = z.object({
  outcome: z.enum(['approved', 'refused']),
  reason: reason.optional(),
});
export const releaseRequestViewSchema = z.object({
  id: z.uuid(),
  instrumentId: z.uuid(),
  caseId: z.uuid(),
  reason: z.string(),
  requestedBy: z.uuid(),
  requestedAt: instant,
});
export type ReleaseRequestView = z.infer<typeof releaseRequestViewSchema>;
export const releaseRequestOutcomeSchema = z.object({
  requestId: z.uuid(),
  outcome: z.enum(['approved', 'refused', 'withdrawn']),
  release: releaseViewSchema.nullable(),
});
export type ReleaseRequestOutcome = z.infer<typeof releaseRequestOutcomeSchema>;
