import * as z from 'zod';
import { PAYMENT_CHANNELS, PAYMENT_REJECT_KINDS } from './receipts.js';

/**
 * What a borrower reads of their own loan (task 6-9; doc 15 §2–3): the schedule with each
 * installment's state, and the slips they sent with their outcome. Their own only (rule 13).
 * Amounts as strings of rials; the page shows tomans.
 */

const rial = z.string().regex(/^\d+$/);

/** As the schedule computes them (task 6-1); a revision may take one to zero (task 4-8). */
export const INSTALLMENT_STATES = [
  'scheduled',
  'due',
  'overdue',
  'partially_paid',
  'paid',
  'cancelled',
] as const;

export const myScheduleSchema = z.object({
  id: z.uuid(),
  totalRial: rial,
  paidRial: rial,
  outstandingRial: rial,
  installments: z.array(
    z.object({
      id: z.uuid(),
      index: z.int(),
      dueOn: z.iso.date(),
      /**
       * Read only (owner 1405/07/24): the nominal due day when this one was moved to a working
       * day (a holiday or a weekly day off) at funding; null when it was not moved.
       */
      movedFrom: z.iso.date().nullable(),
      amountRial: rial,
      paidRial: rial,
      outstandingRial: rial,
      status: z.enum(INSTALLMENT_STATES),
    }),
  ),
});
export type MySchedule = z.infer<typeof myScheduleSchema>;

export const mySchedulesQuerySchema = z.object({ creditApplicationId: z.uuid() });

export const myPaymentSchema = z.object({
  id: z.uuid(),
  amountRial: rial,
  paidOn: z.string().nullable(),
  bankRef: z.string().nullable(),
  channel: z.enum(PAYMENT_CHANNELS),
  status: z.enum(['pending_approval', 'approved', 'rejected']),
  rejectKind: z.enum(PAYMENT_REJECT_KINDS).nullable(),
  rejectReason: z.string().nullable(),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type MyPayment = z.infer<typeof myPaymentSchema>;
