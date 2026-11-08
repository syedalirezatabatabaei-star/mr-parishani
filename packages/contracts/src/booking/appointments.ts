import * as z from 'zod';
import { mobileSchema } from '../identity/auth.js';
import { normalizeDigits } from '../text/digits.js';
import { normalizePersianText } from '../text/persian.js';
import { APPROVAL_MODES } from './schedule.js';

/**
 * Appointments and referrals (task 2-6, doc 08 §7–8, ADR-027). An appointment moves only
 * along APPOINTMENT_TRANSITIONS, through the booking service (rule 8); the database checks
 * the same pairs. Every appointment made through Sepehr has exactly one referral, which is
 * never changed or removed.
 */

const code = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 500);

export const APPOINTMENT_STATUSES = [
  'held',
  'requested',
  'confirmed',
  'checked_in',
  'examined',
  'rejected',
  'expired',
  'cancelled_by_patient',
  'cancelled_by_center',
  'no_show',
  'rescheduled',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * The allowed moves (doc 08 §7). Two were added by the owner (task 2-6 decision 5):
 * requested → cancelled_by_patient (the patient withdraws the request) and
 * requested → expired (the start came and the center never answered).
 */
export const APPOINTMENT_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  held: ['requested', 'expired'],
  requested: ['confirmed', 'rejected', 'cancelled_by_patient', 'expired'],
  confirmed: [
    'checked_in',
    'cancelled_by_patient',
    'cancelled_by_center',
    'no_show',
    'rescheduled',
  ],
  checked_in: ['examined'],
  examined: [],
  rejected: [],
  expired: [],
  cancelled_by_patient: [],
  cancelled_by_center: [],
  no_show: [],
  rescheduled: [],
};

export const canTransition = (from: AppointmentStatus, to: AppointmentStatus) =>
  APPOINTMENT_TRANSITIONS[from].includes(to);

/** An appointment in one of these takes its time: no other may overlap it (doc 08 §7). */
export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'held',
  'requested',
  'confirmed',
  'checked_in',
  'examined',
];

/** Where an appointment was made: the app, the website, or an advisor for the patient. */
export const REFERRAL_CHANNELS = ['app', 'web', 'advisor'] as const;
export type ReferralChannel = (typeof REFERRAL_CHANNELS)[number];

/**
 * A no-show counts only after its dispute is decided (doc 08 §7): upheld, it stands;
 * overturned, it does not.
 */
export const NO_SHOW_DISPUTE_OUTCOMES = ['upheld', 'overturned'] as const;
export type NoShowDisputeOutcome = (typeof NO_SHOW_DISPUTE_OUTCOMES)[number];

/** Six digits, Persian or Arabic digits accepted. */
export const CHECK_IN_CODE_LENGTH = 6;

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/** A patient holds a free slot for a few minutes (`booking.hold_minutes`). */
export const holdAppointmentSchema = z.object({
  workplaceId: z.uuid(),
  serviceCode: code,
  startsAt: instant,
});
export type HoldAppointment = z.input<typeof holdAppointmentSchema>;

/** An advisor holds a slot for a patient, by the patient's mobile. */
export const advisorHoldSchema = holdAppointmentSchema.extend({
  mobile: mobileSchema,
  name: text(2, 200).optional(),
});
export type AdvisorHold = z.input<typeof advisorHoldSchema>;

export const respondAppointmentSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('confirm'), reason: reason.optional() }),
  z.object({ decision: z.literal('reject'), reason }),
]);
export type RespondAppointment = z.input<typeof respondAppointmentSchema>;

export const appointmentReasonSchema = z.object({ reason });

/** Another slot of the same workplace; the old appointment becomes `rescheduled`. */
export const rescheduleAppointmentSchema = z.object({
  startsAt: instant,
  serviceCode: code.optional(),
  reason,
});
export type RescheduleAppointment = z.input<typeof rescheduleAppointmentSchema>;

export const checkInSchema = z.object({
  code: z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(new RegExp(`^[0-9]{${String(CHECK_IN_CODE_LENGTH)}}$`))),
});
export type CheckIn = z.input<typeof checkInSchema>;

export const resolveNoShowDisputeSchema = z.object({
  outcome: z.enum(NO_SHOW_DISPUTE_OUTCOMES),
  reason,
});
export type ResolveNoShowDispute = z.input<typeof resolveNoShowDisputeSchema>;

/** Rials as a string of digits (rule 1): never a JS number. */
export const visitPaymentSchema = z.object({
  amountRial: z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^[1-9][0-9]{0,17}$/)),
  reason: reason.optional(),
});
export type VisitPayment = z.input<typeof visitPaymentSchema>;

/** Gregorian days (the Tehran day), YYYY-MM-DD, inclusive; at most 62 days. */
export const appointmentListQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
  })
  .refine(
    (q) => {
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      return days >= 0 && days < 62;
    },
    { message: 'from..to must cover 1..62 days' },
  );

// --- answers (task 2-11: the OpenAPI document and the generated client are typed by them)

const isoInstant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

/** One appointment as the booking module shows it; the patient also gets the check-in code. */
export const appointmentViewSchema = z.object({
  id: z.uuid(),
  workplaceId: z.uuid(),
  doctorId: z.uuid(),
  serviceCode: z.string(),
  startsAt: isoInstant,
  endsAt: isoInstant,
  status: z.enum(APPOINTMENT_STATUSES),
  channel: z.enum(REFERRAL_CHANNELS),
  /** While held: when the hold lapses. */
  holdExpiresAt: isoInstant.nullable(),
  approvalMode: z.enum(APPROVAL_MODES).nullable(),
  approvalDueAt: isoInstant.nullable(),
  /** The price quoted at booking (rule 16); amounts in rials as strings. */
  price: z.object({
    tariffVersionId: z.uuid(),
    isFree: z.boolean(),
    minAmountRial: rial,
    maxAmountRial: rial,
  }),
  checkedInAt: isoInstant.nullable(),
  rescheduledFromId: z.uuid().nullable(),
  /** The patient's own view only, once confirmed. */
  checkInCode: z.string().nullable().optional(),
});
export type AppointmentViewBody = z.infer<typeof appointmentViewSchema>;

/** An appointment in the patient's list, with what the page shows of it. */
export const patientAppointmentSchema = appointmentViewSchema.extend({
  /**
   * The doctor as on their public profile. Not `doctorName`: that key is the treatment class
   * of doc 04 §4, stripped from the answers of callers without access.view_treatment.
   */
  doctor: z.object({ id: z.uuid(), name: z.string() }),
  /** The center's name; null for a private practice. */
  placeName: z.string().nullable(),
  serviceName: z.string(),
});

export const PATIENT_APPOINTMENTS_MAX_PAGE_SIZE = 50;

const pageNumber = (max: number) =>
  z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^[1-9][0-9]{0,3}$/))
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

/**
 * The query of `GET /booking/me/appointments` (task 2-11: every list filtered on the
 * server): upcoming or past, a status, Tehran days (Gregorian YYYY-MM-DD, inclusive; the
 * page converts from the Jalali days it shows), and a page.
 */
export const patientAppointmentQuerySchema = z
  .object({
    when: z.enum(['upcoming', 'past']).optional(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    page: pageNumber(1000).optional(),
    pageSize: pageNumber(PATIENT_APPOINTMENTS_MAX_PAGE_SIZE).optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  });
export type PatientAppointmentQuery = z.output<typeof patientAppointmentQuerySchema>;

export const patientAppointmentPageSchema = z.object({
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  items: z.array(patientAppointmentSchema),
});
export type PatientAppointmentPage = z.infer<typeof patientAppointmentPageSchema>;

/** `GET /booking/workplaces/:id/free-slots`: the times a patient can take now. */
export const freeSlotListSchema = z.array(
  z.object({ startsAt: isoInstant, endsAt: isoInstant, serviceCodes: z.array(z.string()) }),
);

/** `POST /booking/me/appointments/:id/dispute-no-show`. */
export const noShowDisputedSchema = z.object({
  appointmentId: z.uuid(),
  disputed: z.literal(true),
});

/**
 * An appointment in a workplace's list (the center panel, task 2-11): what the staff needs
 * to receive the patient. The mobile is masked (TODO(decision): whether centers see it in
 * full); the patient proves who they are with the check-in code.
 */
export const workplaceAppointmentSchema = appointmentViewSchema.extend({
  serviceName: z.string(),
  patient: z.object({ mobileMasked: z.string() }),
});
export const workplaceAppointmentListSchema = z.array(workplaceAppointmentSchema);
export type WorkplaceAppointment = z.infer<typeof workplaceAppointmentSchema>;

/** `GET /booking/workplaces/:id/pending-approvals`. */
export const pendingApprovalsSchema = z.object({
  approvalMode: z.enum(APPROVAL_MODES),
  /** Requests still waiting under the manual mode they were made with. */
  waitingForManualApproval: z.int().nonnegative(),
});

/** `POST /booking/appointments/:id/visit-payment`. */
export const visitPaymentRecordedSchema = z.object({ appointmentId: z.uuid(), amountRial: rial });

/** `POST /booking/appointments/:id/no-show-dispute/resolve`: the outcome recorded. */
export const noShowDisputeResolvedSchema = z.object({
  appointmentId: z.uuid(),
  outcome: z.enum(NO_SHOW_DISPUTE_OUTCOMES),
});

/** `GET /booking/referrals`: who referred whom, when (doc 08 §8; the advisor's commission later). */
export const referralListSchema = z.array(
  z.object({
    id: z.uuid(),
    appointmentId: z.uuid(),
    personId: z.uuid(),
    currentPersonId: z.uuid(),
    caseId: z.uuid().nullable(),
    doctorId: z.uuid(),
    workplaceId: z.uuid(),
    channel: z.enum(REFERRAL_CHANNELS),
    referredAt: z.iso.datetime({ offset: true }),
    supersedesReferralId: z.uuid().nullable(),
  }),
);

/** A mobile as staff see it: `0912***4567`. */
export const maskedMobile = (mobile: string) => `0${mobile.slice(0, 3)}***${mobile.slice(-4)}`;
