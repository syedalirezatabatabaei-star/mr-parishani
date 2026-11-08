import {
  APPOINTMENT_STATUSES,
  APPROVAL_MODES,
  AVAILABILITY_EXCEPTION_KINDS,
  NO_SHOW_DISPUTE_OUTCOMES,
  REFERRAL_CHANNELS,
  WEEKDAYS,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { appendOnlyTimestamps, id, rial, timestamps, timestamptz } from '../../db/columns';

/**
 * A doctor's calendar at each workplace (task 2-5, doc 08 §6, ADR-025). Slots are never
 * stored; they are computed from these rows, the holidays and the appointments. The
 * workplace and the doctor are the catalog's (read through WORKPLACE_DIRECTORY), so they
 * are ids here, not foreign keys (module boundary). Times are minutes since Tehran midnight.
 */

/** One range of the weekly schedule. Replacing a schedule removes the old rows (rule 7). */
export const scheduleTemplates = pgTable(
  'schedule_templates',
  {
    id: id(),
    workplaceId: uuid('workplace_id').notNull(),
    /** The doctor of the workplace: one doctor is never in two places at once. */
    doctorId: uuid('doctor_id').notNull(),
    weekday: text('weekday', { enum: WEEKDAYS }).notNull(),
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
    slotMinutes: integer('slot_minutes').notNull(),
    serviceCodes: text('service_codes').array().notNull(),
    createdBy: uuid('created_by'),
    deletedBy: uuid('deleted_by'),
    ...timestamps(),
  },
  (t) => [
    index('schedule_templates_workplace_id_idx')
      .on(t.workplaceId)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** A change on one Tehran day: closed, extra hours, or a holiday opened. */
export const availabilityExceptions = pgTable(
  'availability_exceptions',
  {
    id: id(),
    workplaceId: uuid('workplace_id').notNull(),
    doctorId: uuid('doctor_id').notNull(),
    /** The Tehran calendar day, stored as its Gregorian date (like holidays). */
    onDay: date('on_day', { mode: 'string' }).notNull(),
    kind: text('kind', { enum: AVAILABILITY_EXCEPTION_KINDS }).notNull(),
    startMinute: integer('start_minute'),
    endMinute: integer('end_minute'),
    slotMinutes: integer('slot_minutes'),
    serviceCodes: text('service_codes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    deletedBy: uuid('deleted_by'),
    ...timestamps(),
  },
  (t) => [
    index('availability_exceptions_workplace_day_idx')
      .on(t.workplaceId, t.onDay)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('availability_exceptions_open_holiday_key')
      .on(t.workplaceId, t.onDay)
      .where(sql`${t.kind} = 'open_holiday' AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * How a workplace approves its appointments, append-only: the latest row is in force,
 * and none means the configured default. Appointments (task 2-6) lock the row they used.
 */
export const workplaceApprovalModes = pgTable(
  'workplace_approval_modes',
  {
    id: id(),
    workplaceId: uuid('workplace_id').notNull(),
    mode: text('mode', { enum: APPROVAL_MODES }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('workplace_approval_modes_workplace_idx').on(t.workplaceId, t.createdAt)],
);

/**
 * Appointments (task 2-6, doc 08 §7, ADR-027). The status moves only through the booking
 * service along APPOINTMENT_TRANSITIONS (rule 8); a trigger refuses any other pair, and the
 * app role may update only the columns a move sets. No two live appointments of one
 * doctor overlap, at any of their workplaces: an exclusion constraint decides, not code.
 * The price is the tariff version quoted at booking (rule 16): later prices never reach it.
 */
export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    workplaceId: uuid('workplace_id').notNull(),
    doctorId: uuid('doctor_id').notNull(),
    /** The patient's account; null when an advisor booked for someone without one. */
    patientAccountId: uuid('patient_account_id'),
    /** Normalized 9XXXXXXXXX: who the SMS go to, and the intake's mobile. */
    mobile: text('mobile').notNull(),
    /** Set on request, with the case (lead module, through LEAD_CASES). */
    personId: uuid('person_id'),
    /** Null for a person who asked not to be contacted (task 2-6 decision 2). */
    caseId: uuid('case_id'),
    serviceCode: text('service_code').notNull(),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    status: text('status', { enum: APPOINTMENT_STATUSES }).notNull().default('held'),
    channel: text('channel', { enum: REFERRAL_CHANNELS }).notNull(),
    holdExpiresAt: timestamptz('hold_expires_at').notNull(),
    /** The mode in force at the request; the appointment keeps it (task 2-6 decision 1). */
    approvalMode: text('approval_mode', { enum: APPROVAL_MODES }),
    /** The workplace_approval_modes row, or the config version of the default. */
    approvalModeVersionId: uuid('approval_mode_version_id'),
    approvalDueAt: timestamptz('approval_due_at'),
    tariffVersionId: uuid('tariff_version_id').notNull(),
    tariffIsFree: boolean('tariff_is_free').notNull(),
    tariffMinAmountRial: rial('tariff_min_amount_rial').notNull(),
    tariffMaxAmountRial: rial('tariff_max_amount_rial').notNull(),
    /** Shown to the patient once confirmed; the center enters it at check-in. */
    checkInCode: text('check_in_code'),
    checkInAttempts: integer('check_in_attempts').notNull().default(0),
    checkedInAt: timestamptz('checked_in_at'),
    rescheduledFromId: uuid('rescheduled_from_id').references((): AnyPgColumn => appointments.id),
    /** Who made it: the patient, or the advisor for them. */
    createdBy: uuid('created_by'),
    idempotencyKey: text('idempotency_key'),
    ...timestamps(),
  },
  (t) => [
    index('appointments_workplace_starts_idx').on(t.workplaceId, t.startsAt),
    index('appointments_doctor_starts_idx').on(t.doctorId, t.startsAt),
    index('appointments_patient_account_idx').on(t.patientAccountId, t.startsAt),
    index('appointments_person_id_idx').on(t.personId),
    index('appointments_case_id_idx').on(t.caseId),
    index('appointments_held_idx')
      .on(t.holdExpiresAt)
      .where(sql`${t.status} = 'held'`),
    index('appointments_requested_idx')
      .on(t.approvalDueAt)
      .where(sql`${t.status} = 'requested'`),
    index('appointments_confirmed_idx')
      .on(t.startsAt)
      .where(sql`${t.status} = 'confirmed'`),
    uniqueIndex('appointments_rescheduled_from_key').on(t.rescheduledFromId),
    uniqueIndex('appointments_idempotency_key')
      .on(t.createdBy, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

/** Every move of an appointment, with who and why. */
export const appointmentStatusChanges = pgTable(
  'appointment_status_changes',
  {
    id: id(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    fromStatus: text('from_status', { enum: APPOINTMENT_STATUSES }),
    toStatus: text('to_status', { enum: APPOINTMENT_STATUSES }).notNull(),
    actorAccountId: uuid('actor_account_id'),
    reason: text('reason'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('appointment_status_changes_appointment_idx').on(t.appointmentId, t.createdAt)],
);

/**
 * A referral (doc 08 §8): one per appointment made through Sepehr, never changed or
 * removed. The basis of the cash-service commission (phase 5). It keeps the person and
 * case of its day; a later merge of persons is followed when read (LEAD_CASES). A
 * rescheduled appointment's referral points to the one it supersedes and keeps the
 * original referral date (task 2-6 decision 4).
 */
export const referrals = pgTable(
  'referrals',
  {
    id: id(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    personId: uuid('person_id').notNull(),
    caseId: uuid('case_id'),
    doctorId: uuid('doctor_id').notNull(),
    workplaceId: uuid('workplace_id').notNull(),
    channel: text('channel', { enum: REFERRAL_CHANNELS }).notNull(),
    referredAt: timestamptz('referred_at').notNull(),
    supersedesReferralId: uuid('supersedes_referral_id').references(
      (): AnyPgColumn => referrals.id,
    ),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('referrals_appointment_key').on(t.appointmentId),
    uniqueIndex('referrals_supersedes_key').on(t.supersedesReferralId),
    index('referrals_doctor_referred_idx').on(t.doctorId, t.referredAt),
    index('referrals_person_id_idx').on(t.personId),
  ],
);

/** A patient's dispute of a no-show, and its decision (doc 08 §7). One per appointment. */
export const noShowDisputes = pgTable(
  'no_show_disputes',
  {
    id: id(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    outcome: text('outcome', { enum: NO_SHOW_DISPUTE_OUTCOMES }),
    resolutionReason: text('resolution_reason'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamptz('resolved_at'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('no_show_disputes_appointment_key').on(t.appointmentId)],
);

/**
 * «Visit paid» at the center (doc 08 §7). Money paid to the center, not to the lender: no
 * ledger entry. Once per appointment, never changed.
 */
export const visitPayments = pgTable(
  'visit_payments',
  {
    id: id(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    amountRial: rial('amount_rial').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('visit_payments_appointment_key').on(t.appointmentId)],
);

/** What the scheduler already announced (a reminder per offset, an overdue answer): once. */
export const appointmentNotices = pgTable(
  'appointment_notices',
  {
    id: id(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    kind: text('kind', { enum: ['reminder', 'approval_overdue'] }).notNull(),
    /** The reminder's offset in minutes; 0 for an overdue answer. */
    offsetMinutes: integer('offset_minutes').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('appointment_notices_key').on(t.appointmentId, t.kind, t.offsetMinutes)],
);
