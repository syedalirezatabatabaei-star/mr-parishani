import * as z from 'zod';

/**
 * The customer club (ADR-048; owner 1405/07/30, answer 2): a membership recorded by a club
 * officer, with its first and last day, who recorded it and why; append-only, an early end is a
 * revocation of its own. A club plan is offered only to a member on the case's creation day,
 * and the membership is locked on the application (rule 16).
 */

const reason = z.string().trim().min(3).max(500);

export const recordClubMembershipSchema = z
  .strictObject({
    /** The member's mobile, in any form; normalized before the lookup (rule 24). */
    mobile: z.string().trim().min(10).max(20),
    /** Gregorian days (YYYY-MM-DD); the UI takes them in Jalali. */
    startsOn: z.iso.date(),
    /** The last day, inclusive; absent while open. */
    endsOn: z.iso.date().optional(),
    reason,
  })
  .refine((v) => v.endsOn === undefined || v.endsOn >= v.startsOn, {
    message: 'the last day is before the first',
    path: ['endsOn'],
  });
export type RecordClubMembership = z.input<typeof recordClubMembershipSchema>;

export const revokeClubMembershipSchema = z.strictObject({
  /** The first day it no longer counts. */
  revokedOn: z.iso.date(),
  reason,
});
export type RevokeClubMembership = z.input<typeof revokeClubMembershipSchema>;

export const clubMembershipsQuerySchema = z.strictObject({
  mobile: z.string().trim().min(10).max(20),
});

const instant = z.iso.datetime({ offset: true });

export const clubMembershipViewSchema = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  reason: z.string(),
  recordedAt: instant,
  revocation: z
    .object({ revokedOn: z.string(), reason: z.string(), recordedAt: instant })
    .nullable(),
  /** A member today, in Tehran. */
  activeToday: z.boolean(),
});
export type ClubMembershipView = z.infer<typeof clubMembershipViewSchema>;
