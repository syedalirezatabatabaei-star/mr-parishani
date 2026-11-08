import * as z from 'zod';

/**
 * Cash services and their fee (task 5-3 [financial]; doc 06 §4; doc 14 ت; client answers
 * 1405/07/10 §3). A patient Sepehr referred to a doctor who was then served for cash: only
 * with a referral to that very doctor, at any time after it (no window). The doctor's own
 * word is confirmed at once; an advisor's waits for someone else's. Only a confirmed one
 * gets its fee. Amounts are whole rials as text; the day is Gregorian (Jalali on the page).
 */

export const CASH_SERVICE_STATUSES = ['recorded', 'disputed', 'confirmed', 'voided'] as const;
export type CashServiceStatus = (typeof CASH_SERVICE_STATUSES)[number];
export const CASH_SERVICE_SOURCES = ['doctor_declared', 'advisor_recorded'] as const;
export type CashServiceSource = (typeof CASH_SERVICE_SOURCES)[number];

const reason = z.string().trim().min(3).max(1000);

export const recordCashServiceSchema = z.strictObject({
  referralId: z.uuid(),
  /** Absent: the referral's own workplace; else another of the same doctor. */
  workplaceId: z.uuid().optional(),
  serviceDate: z.iso.date(),
  amountRial: z.string().regex(/^[1-9]\d{0,17}$/),
  /** The client's key: the same request twice records one (rule 5). */
  idempotencyKey: z.string().min(8).max(200),
});
export type RecordCashService = z.infer<typeof recordCashServiceSchema>;

export const decideCashServiceSchema = z.strictObject({
  outcome: z.enum(['confirm', 'void']),
  reason,
});
export const disputeCashServiceSchema = z.strictObject({ reason });

export const cashServiceQuerySchema = z.object({
  status: z.enum(CASH_SERVICE_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });

export const cashServiceViewSchema = z.object({
  id: z.uuid(),
  referralId: z.uuid(),
  doctorId: z.uuid(),
  workplaceId: z.uuid(),
  serviceDate: z.iso.date(),
  amountRial: z.string(),
  source: z.enum(CASH_SERVICE_SOURCES),
  status: z.enum(CASH_SERVICE_STATUSES),
  recordedAt: instant,
  /** A recorded service is never confirmed by who recorded it. */
  recordedByMe: z.boolean(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
  /** Once confirmed: its fee (0 while the rate is 0) and when it is due. */
  fee: z
    .object({
      id: z.uuid(),
      amountRial: z.string(),
      basis: z.enum(['percent', 'fixed']),
      rateValue: z.string(),
      dueAt: instant,
      status: z.string(),
    })
    .nullable(),
});
export type CashServiceView = z.infer<typeof cashServiceViewSchema>;
