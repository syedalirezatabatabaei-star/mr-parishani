import * as z from 'zod';
import { rialAmountSchema } from '../catalog/tariffs.js';

/**
 * Overdue loans' follow-up (task 6-7; doc 15 §5; owner 1405/07/16): the queue by days past
 * due, collection actions, payment promises judged on their day, escalation that only makes
 * tasks, and a borrower's deceased or disabled status. The collection unit never sees the
 * treatment, the doctor or the center (doc 04 §4): none of these shapes has such a field.
 */

export const COLLECTION_ACTION_KINDS = [
  'call',
  'sms',
  'visit',
  'letter',
  'guarantor_contact',
  'legal_referral',
] as const;
export type CollectionActionKind = (typeof COLLECTION_ACTION_KINDS)[number];

export const PAYMENT_PROMISE_STATUSES = ['open', 'kept', 'broken', 'cancelled'] as const;
export type PaymentPromiseStatus = (typeof PAYMENT_PROMISE_STATUSES)[number];

/**
 * call (stage 1), guarantor_notice (stage 2: sent only by a person's decision), suggest_cheque
 * (stage 3) and legal_referral (stage 4): proposed by the collection agent, decided by the
 * collection manager, never the same person; promise_broken: the agent told.
 */
export const COLLECTION_TASK_KINDS = [
  'call',
  'guarantor_notice',
  'suggest_cheque',
  'legal_referral',
  'promise_broken',
] as const;
export type CollectionTaskKind = (typeof COLLECTION_TASK_KINDS)[number];

export const COLLECTION_TASK_STATUSES = ['open', 'proposed', 'done', 'dismissed'] as const;
export type CollectionTaskStatus = (typeof COLLECTION_TASK_STATUSES)[number];

/** Stages 3 and 4: a human decision by two people (doc 15 §5). */
export const TWO_PERSON_STAGES: readonly number[] = [3, 4];

export const BORROWER_STATUS_KINDS = ['deceased', 'disabled', 'lifted'] as const;
export type BorrowerStatusKind = (typeof BORROWER_STATUS_KINDS)[number];

export const COLLECTION_CLOSE_REASONS = ['cured', 'settled', 'cancelled'] as const;
export type CollectionCloseReason = (typeof COLLECTION_CLOSE_REASONS)[number];

// --- configuration (owner: every threshold and day in the panel) -------------------------

/** The lower bound of each bucket of days past due, ascending (6.4: 1, 31, 61, 91). */
export const collectionBucketsSchema = z
  .array(z.number().int().min(1).max(3650))
  .min(1)
  .max(12)
  .refine((b) => b.every((d, i) => i === 0 || d > (b[i - 1] ?? 0)), 'ascending');

const stageRule = z.strictObject({
  minDays: z.number().int().min(1).max(3650),
  /** Or this many overdue installments, whichever comes first; absent: days only. */
  minInstallments: z.number().int().min(1).max(120).optional(),
});

/** Stages 1 to 3 by days past due or overdue installments (6.4); stage 4 by a bounced cheque. */
export const escalationRulesSchema = z.strictObject({
  stage1: stageRule,
  stage2: stageRule,
  stage3: stageRule,
});
export type EscalationRules = z.output<typeof escalationRulesSchema>;

/** The bucket a lateness falls in: its index and bounds (`to` null for the last). */
export function bucketOf(
  daysPastDue: number,
  buckets: readonly number[],
): { index: number; from: number; to: number | null } | null {
  let found: { index: number; from: number; to: number | null } | null = null;
  buckets.forEach((from, index) => {
    if (daysPastDue >= from) {
      const next = buckets[index + 1];
      found = { index, from, to: next === undefined ? null : next - 1 };
    }
  });
  return found;
}

/** The stages (1 to 3) a case's lateness has reached, by its rules. */
export function stagesReached(
  daysPastDue: number,
  overdueInstallments: number,
  rules: EscalationRules,
): number[] {
  const reached = (r: z.output<typeof stageRule>) =>
    daysPastDue >= r.minDays ||
    (r.minInstallments !== undefined && overdueInstallments >= r.minInstallments);
  return [rules.stage1, rules.stage2, rules.stage3]
    .map((r, i) => (reached(r) ? i + 1 : 0))
    .filter((s) => s > 0);
}

/** The task each stage makes. */
export const STAGE_TASK: Readonly<Record<number, CollectionTaskKind>> = {
  1: 'call',
  2: 'guarantor_notice',
  3: 'suggest_cheque',
  4: 'legal_referral',
};

// --- inputs -------------------------------------------------------------------------------

const note = z.string().trim().min(3).max(1000);

export const collectionQueueQuerySchema = z.strictObject({
  bucket: z.coerce.number().int().min(0).max(11).optional(),
  mine: z.enum(['true', 'false']).optional(),
});

export const recordCollectionActionSchema = z.strictObject({
  kind: z.enum(COLLECTION_ACTION_KINDS),
  outcome: z.string().trim().min(2).max(200),
  note: z.string().trim().max(2000).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  nextFollowUpAt: z.iso.datetime({ offset: true }).optional(),
});

export const createPaymentPromiseSchema = z.strictObject({
  amountRial: rialAmountSchema,
  /** Gregorian day (YYYY-MM-DD); the UI takes it in Jalali. */
  promisedOn: z.iso.date(),
  note: z.string().trim().max(1000).optional(),
});

export const reasonSchema = z.strictObject({ reason: note });

export const workCollectionTaskSchema = z.strictObject({
  outcome: z.enum(['done', 'dismissed']),
  note,
});

export const decideCollectionTaskSchema = z.strictObject({
  decision: z.enum(['done', 'dismissed']),
  note,
});

export const assignCollectionItemSchema = z.strictObject({
  accountId: z.uuid(),
  reason: note,
});

/** Multipart fields with the document file. */
export const proposeBorrowerStatusSchema = z.strictObject({
  itemId: z.uuid(),
  kind: z.enum(BORROWER_STATUS_KINDS),
  note,
});

export const smsPreviewQuerySchema = z.strictObject({
  audience: z.enum(['borrower', 'guarantor']),
});

// --- views --------------------------------------------------------------------------------

const instant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const collectionQueueRowSchema = z.object({
  itemId: z.uuid(),
  caseId: z.uuid(),
  borrowerName: z.string().nullable(),
  borrowerMobile: z.string().nullable(),
  maxDaysPastDue: z.number().int(),
  overdueInstallments: z.number().int(),
  overdueRial: rial,
  bucket: z.number().int().nullable(),
  assigneeAccountId: z.uuid().nullable(),
  openedAt: instant,
  openTasks: z.number().int(),
  borrowerHeld: z.boolean(),
});
export type CollectionQueueRow = z.output<typeof collectionQueueRowSchema>;

export const collectionItemSchema = z.object({
  itemId: z.uuid(),
  caseId: z.uuid(),
  openedAt: instant,
  closedAt: instant.nullable(),
  closeReason: z.enum(COLLECTION_CLOSE_REASONS).nullable(),
  assigneeAccountId: z.uuid().nullable(),
  borrower: z.object({
    personId: z.uuid(),
    name: z.string().nullable(),
    mobile: z.string().nullable(),
    held: z.boolean(),
  }),
  guarantors: z.array(
    z.object({ guarantorId: z.uuid(), name: z.string().nullable(), mobile: z.string().nullable() }),
  ),
  installments: z.array(
    z.object({
      scheduleId: z.uuid(),
      index: z.number().int(),
      dueOn: z.iso.date(),
      amountRial: rial,
      paidRial: rial,
      outstandingRial: rial,
      status: z.string(),
      daysPastDue: z.number().int(),
    }),
  ),
  payments: z.array(
    z.object({ paymentId: z.uuid(), amountRial: rial, status: z.string(), receivedAt: instant }),
  ),
  actions: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(COLLECTION_ACTION_KINDS),
      outcome: z.string(),
      note: z.string().nullable(),
      occurredAt: instant,
      nextFollowUpAt: instant.nullable(),
      actorAccountId: z.uuid().nullable(),
    }),
  ),
  promises: z.array(
    z.object({
      id: z.uuid(),
      amountRial: rial,
      promisedOn: z.iso.date(),
      status: z.enum(PAYMENT_PROMISE_STATUSES),
      allocatedRial: rial.nullable(),
      createdAt: instant,
    }),
  ),
  tasks: z.array(
    z.object({
      id: z.uuid(),
      stage: z.number().int(),
      kind: z.enum(COLLECTION_TASK_KINDS),
      status: z.enum(COLLECTION_TASK_STATUSES),
      createdAt: instant,
      proposedBy: z.uuid().nullable(),
      decidedBy: z.uuid().nullable(),
    }),
  ),
});
export type CollectionItemView = z.output<typeof collectionItemSchema>;

/** Stage 3 and 4 proposals waiting for the collection manager (task 6-9). */
export const proposedTaskSchema = z.object({
  taskId: z.uuid(),
  itemId: z.uuid(),
  caseId: z.uuid(),
  stage: z.number().int(),
  kind: z.enum(COLLECTION_TASK_KINDS),
  proposedBy: z.uuid().nullable(),
  proposalNote: z.string().nullable(),
  proposedAt: instant.nullable(),
});

export const borrowerStatusEventSchema = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  kind: z.enum(BORROWER_STATUS_KINDS),
  proposedBy: z.uuid().nullable(),
  approvedBy: z.uuid().nullable(),
  createdAt: instant,
  approvedAt: instant.nullable(),
});

export const smsPreviewSchema = z.object({
  audience: z.enum(['borrower', 'guarantor']),
  templateCode: z.string(),
  text: z.string(),
});
