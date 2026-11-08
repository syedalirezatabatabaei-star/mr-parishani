import * as z from 'zod';

/**
 * Financial disputes on settlement items (task 5-2 [financial]; doc 14, doc 06 §4; owner
 * 1405/07/14). A dispute holds the item (and its sibling of the same service) out of every
 * statement and payment. Rejected: the items go back. Accepted on a fee: its document is
 * reversed whole. Accepted on a doctor's payable: `accepted_pending_posting` only; the items
 * stay held and nothing is posted until task 5-2b.
 */

export const DISPUTE_SUBJECTS = ['doctor_payable', 'service_fee'] as const;
export type DisputeSubject = (typeof DISPUTE_SUBJECTS)[number];
export const DISPUTE_STATUSES = [
  'open',
  'resolved_accepted',
  'resolved_rejected',
  'accepted_pending_posting',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

const text = z.string().trim().min(3).max(1000);

export const openDisputeSchema = z.strictObject({
  subjectType: z.enum(DISPUTE_SUBJECTS),
  subjectId: z.uuid(),
  reason: text,
});
export type OpenDispute = z.infer<typeof openDisputeSchema>;

export const resolveDisputeSchema = z.strictObject({
  outcome: z.enum(['accepted', 'rejected']),
  note: text,
});
export type ResolveDispute = z.infer<typeof resolveDisputeSchema>;

export const disputeQuerySchema = z.object({
  status: z.enum(DISPUTE_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });

export const disputeViewSchema = z.object({
  id: z.uuid(),
  subjectType: z.enum(DISPUTE_SUBJECTS),
  subjectId: z.uuid(),
  reason: z.string(),
  status: z.enum(DISPUTE_STATUSES),
  openedAt: instant,
  /** A dispute is never decided by who opened it. */
  openedByMe: z.boolean(),
  resolvedAt: instant.nullable(),
  resolutionNote: z.string().nullable(),
  correctionJournalEntryId: z.uuid().nullable(),
  /** What it holds, and what each was before. */
  items: z.array(
    z.object({
      itemType: z.enum(DISPUTE_SUBJECTS),
      itemId: z.uuid(),
      heldFromStatus: z.enum(['accrued', 'due', 'in_statement']),
    }),
  ),
});
export type DisputeView = z.infer<typeof disputeViewSchema>;
