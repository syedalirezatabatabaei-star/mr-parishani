import * as z from 'zod';

/**
 * A case's own cancellation-penalty rate (task 4-8 [financial], part 7; doc 02 §6 item 4;
 * owner پ۱۳, 1405/07/14): asked by one person, approved by another, with a reason; 0 to 18%
 * (higher only with a new ADR); it counts only for a contract made after it is approved, which
 * locks the rate (owner س۴). Rates in basis points (1800 = 18%).
 */

export const PENALTY_OVERRIDE_STATUSES = ['requested', 'approved', 'rejected'] as const;
export type PenaltyOverrideStatus = (typeof PENALTY_OVERRIDE_STATUSES)[number];

const reason = z.string().trim().min(3).max(500);

export const requestPenaltyOverrideSchema = z.strictObject({
  penaltyBps: z.int().min(0).max(1_800),
  reason,
});

export const decidePenaltyOverrideSchema = z.strictObject({ reason });

const instant = z.iso.datetime({ offset: true });

export const penaltyOverrideViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  penaltyBps: z.int(),
  reason: z.string(),
  status: z.enum(PENALTY_OVERRIDE_STATUSES),
  requestedAt: instant,
  /** A request is never decided by who asked it. */
  requestedByMe: z.boolean(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
});
export type PenaltyOverrideView = z.infer<typeof penaltyOverrideViewSchema>;
