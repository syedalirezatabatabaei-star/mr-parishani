import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AppointmentStatus,
  type AuthClient,
  maskedMobile,
  type PatientAppointmentPage,
  type WorkplaceAppointment,
  type PatientAppointmentQuery,
  type ApprovalMode,
  type appointmentListQuerySchema,
  type ReferralChannel,
  type resolveNoShowDisputeSchema,
  type respondAppointmentSchema,
  type visitPaymentSchema,
  CHECK_IN_CODE_LENGTH,
  canTransition,
  fromJalali,
  nextJalaliDay,
  gregorianToJalali,
} from '@sepehr/contracts';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { TARIFF_BOOK, type TariffBook } from '../../common/catalog/tariff-book.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
  type WorkplaceRecord,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../db/database.module';
import {
  lockAppointment,
  moveAppointment,
  pgCode,
  recordMove,
  type AppointmentRow,
  type Tx,
} from './appointment-lifecycle';
import { AvailabilityService, isBookable, tehranDayOf } from './availability.service';
import { appointments, noShowDisputes, visitPayments } from './booking.schema';
import { CalendarService } from './calendar.service';
import { ReferralService } from './referral.service';

const MINUTE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Wrong check-in codes before the code stops working; the center then calls support. */
const MAX_CHECK_IN_ATTEMPTS = 5;

/** Who books: the patient themselves (app or website), or an advisor for a patient. */
export type Booker =
  | { readonly kind: 'patient'; readonly accountId: string; readonly client: AuthClient }
  | {
      readonly kind: 'advisor';
      readonly accountId: string;
      readonly mobile: string;
      readonly name: string | null;
    };

export interface HoldInput {
  readonly workplaceId: string;
  readonly serviceCode: string;
  readonly startsAt: Date;
}

export interface AppointmentView {
  readonly id: string;
  readonly workplaceId: string;
  readonly doctorId: string;
  readonly serviceCode: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: AppointmentStatus;
  readonly channel: ReferralChannel;
  /** While held: when the hold lapses. */
  readonly holdExpiresAt: string | null;
  readonly approvalMode: ApprovalMode | null;
  readonly approvalDueAt: string | null;
  /** The price quoted at booking (rule 16); amounts in rials as strings. */
  readonly price: {
    readonly tariffVersionId: string;
    readonly isFree: boolean;
    readonly minAmountRial: string;
    readonly maxAmountRial: string;
  };
  readonly checkedInAt: string | null;
  readonly rescheduledFromId: string | null;
  /** The patient's own view only, once confirmed. */
  readonly checkInCode?: string | null;
}

export interface PendingManualView {
  /** The mode new appointments get now. */
  readonly approvalMode: ApprovalMode;
  /**
   * Requests still waiting for the center under the manual mode they were made with (task
   * 2-6 decision 1): switching to automatic never confirms them, so the panel warns.
   */
  readonly waitingForManualApproval: number;
}

const view = (row: AppointmentRow, forPatient = false): AppointmentView => ({
  id: row.id,
  workplaceId: row.workplaceId,
  doctorId: row.doctorId,
  serviceCode: row.serviceCode,
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt.toISOString(),
  status: row.status,
  channel: row.channel,
  holdExpiresAt: row.status === 'held' ? row.holdExpiresAt.toISOString() : null,
  approvalMode: row.approvalMode,
  approvalDueAt: row.approvalDueAt?.toISOString() ?? null,
  price: {
    tariffVersionId: row.tariffVersionId,
    isFree: row.tariffIsFree,
    minAmountRial: row.tariffMinAmountRial.toString(),
    maxAmountRial: row.tariffMaxAmountRial.toString(),
  },
  checkedInAt: row.checkedInAt?.toISOString() ?? null,
  rescheduledFromId: row.rescheduledFromId,
  ...(forPatient ? { checkInCode: row.status === 'confirmed' ? row.checkInCode : null } : {}),
});

const newCheckInCode = () =>
  String(randomInt(0, 10 ** CHECK_IN_CODE_LENGTH)).padStart(CHECK_IN_CODE_LENGTH, '0');

const notFound = () => new NotFoundException({ error: 'appointment_not_found' });
const unavailable = () => new ConflictException({ error: 'booking_unavailable' });

/** A system actor for what the booking module does on its own (an expired hold). */
export const BOOKING_SYSTEM_ACTOR: Actor = {
  accountId: null,
  sessionId: null,
  ip: null,
  roles: ['booking'],
};

/**
 * Appointments (task 2-6, doc 08 §7, ADR-027).
 *
 * - A patient holds a free slot for `booking.hold_minutes`, then requests it. Whether two
 *   people get the same time is decided by the database's exclusion constraint alone
 *   (task 2-6 decision 7): the checks before it only give a clearer answer earlier.
 * - A request goes through the lead module's one intake (LEAD_CASES), which finds or opens
 *   the person's case (decision 3), and writes the appointment's one referral. A person
 *   blocked for abuse is refused without a reason (decision 2).
 * - The approval mode in force at the request is stored on the appointment and kept
 *   (decision 1): manual waits for the center, within `booking.center_approval_sla_minutes`;
 *   automatic confirms at once.
 * - The center answers, checks in with the patient's code, marks examined or no-show,
 *   cancels or moves; the patient cancels until `booking.patient_cancel_cutoff_minutes`
 *   before, moves, or disputes a no-show.
 *
 * Staff reach an appointment through its workplace: the permission, and a scope that
 * covers the workplace (doctor, secretary by delegation, center or branch, city or
 * global), checked here on every request (rules 12 and 13). Out of scope, it does not
 * exist. Patients reach their own only.
 */
@Injectable()
export class AppointmentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(WORKPLACE_DIRECTORY) private readonly directory: WorkplaceDirectory,
    @Inject(TARIFF_BOOK) private readonly tariffs: TariffBook,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    private readonly availability: AvailabilityService,
    private readonly calendars: CalendarService,
    private readonly referrals: ReferralService,
  ) {}

  // --- hold and request ---------------------------------------------------------------

  async hold(
    actor: Actor,
    booker: Booker,
    input: HoldInput,
    idempotencyKey: string | null,
    now = new Date(),
  ): Promise<AppointmentView> {
    const forPatient = booker.kind === 'patient';
    if (idempotencyKey !== null) {
      const earlier = await this.byIdempotencyKey(booker.accountId, idempotencyKey);
      if (earlier) return view(earlier, forPatient);
    }
    const mobile =
      booker.kind === 'patient' ? await this.patientMobile(booker.accountId) : booker.mobile;
    if ((await this.leads.standingOf(mobile)) === 'abuse') throw unavailable();

    const workplace = await this.directory.workplace(input.workplaceId);
    if (!workplace) throw new NotFoundException({ error: 'workplace_not_found' });
    if (!isBookable(workplace)) throw new ConflictException({ error: 'workplace_not_bookable' });
    const slot = await this.findSlot(workplace, input.serviceCode, input.startsAt, now);
    const quote = await this.tariffs.quote(workplace.id, input.serviceCode, now);
    if (!quote) throw new ConflictException({ error: 'service_not_priced' });
    const holdMinutes = (await this.config.resolve('booking.hold_minutes')).value;

    // Holds past their time give the slot back first, in their own transaction: the
    // insert below may wait on another booking's row, and must not hold the audit lock then.
    await this.expireStaleHolds(workplace.doctorId, slot.startsAt, slot.endsAt, now, booker);

    const channel: ReferralChannel =
      booker.kind === 'advisor' ? 'advisor' : booker.client === 'web' ? 'web' : 'app';
    let held: AppointmentView | null;
    try {
      held = await this.db.transaction(async (tx) => {
        // The exclusion constraint is the arbiter (doc 08 §15 test 1, task 2-6 decision 7).
        // ON CONFLICT DO NOTHING makes Postgres check it by speculative insertion, which
        // waits for a concurrent conflicting insert instead of deadlocking with it (a plain
        // INSERT can: both place their index entry, then each waits for the other). No row
        // back means the time is taken, or this idempotency key was used.
        const [row] = await tx
          .insert(appointments)
          .values({
            workplaceId: workplace.id,
            doctorId: workplace.doctorId,
            patientAccountId: booker.kind === 'patient' ? booker.accountId : null,
            mobile,
            serviceCode: input.serviceCode,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            status: 'held',
            channel,
            holdExpiresAt: new Date(now.getTime() + holdMinutes * MINUTE_MS),
            tariffVersionId: quote.tariffVersionId,
            tariffIsFree: quote.isFree,
            tariffMinAmountRial: quote.minAmountRial,
            tariffMaxAmountRial: quote.maxAmountRial,
            createdBy: booker.accountId,
            idempotencyKey,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) return null;
        await recordMove(this.deps, tx, actor, row, null, null);
        return view(row, forPatient);
      });
    } catch (error) {
      // Should ON CONFLICT not apply (it always does here), the constraint still refuses.
      if (pgCode(error) === '23P01') throw new ConflictException({ error: 'slot_taken' });
      throw error;
    }
    if (held) return held;
    if (idempotencyKey !== null) {
      const earlier = await this.byIdempotencyKey(booker.accountId, idempotencyKey);
      if (earlier) return view(earlier, forPatient);
    }
    throw new ConflictException({ error: 'slot_taken' });
  }

  /** The held slot becomes a request: a case, a referral, and the workplace's approval. */
  async submit(
    actor: Actor,
    booker: { readonly kind: 'patient' | 'advisor'; readonly accountId: string },
    appointmentId: string,
    now = new Date(),
  ): Promise<AppointmentView> {
    const current = await this.readRow(appointmentId);
    const [settings, approval, sla] = await Promise.all([
      this.leads.intakeSettings(),
      this.calendars.approvalModeOf(current.workplaceId),
      this.config.resolve('booking.center_approval_sla_minutes'),
    ]);
    return this.db.transaction(async (tx) => {
      const row = await lockAppointment(tx, appointmentId);
      if (!row || !this.madeBy(row, booker)) throw notFound();
      if (row.status !== 'held') {
        throw new ConflictException({
          error: 'invalid_transition',
          from: row.status,
          to: 'requested',
        });
      }
      if (row.holdExpiresAt <= now) throw new ConflictException({ error: 'hold_expired' });
      const workplace = await this.directory.workplace(row.workplaceId, tx);
      if (!workplace || !isBookable(workplace)) {
        throw new ConflictException({ error: 'workplace_not_bookable' });
      }
      const fieldCode = await this.directory.treatmentFieldFor(workplace.id, row.serviceCode, tx);
      if (!fieldCode) throw new ConflictException({ error: 'service_not_offered' });
      const opened = await this.leads.openForBooking(
        tx,
        actor,
        {
          mobile: row.mobile,
          treatmentFieldCode: fieldCode,
          cityCode: workplace.cityCode,
          channel: row.channel === 'advisor' ? 'advisor' : 'app',
        },
        settings,
      );
      if (opened.kind === 'refused') throw unavailable();

      const requested = await moveAppointment(this.deps, tx, actor, row, 'requested', {
        set: {
          personId: opened.personId,
          caseId: opened.kind === 'case' ? opened.caseId : null,
          approvalMode: approval.mode,
          approvalModeVersionId: approval.versionId,
          approvalDueAt:
            approval.mode === 'manual' ? new Date(now.getTime() + sla.value * MINUTE_MS) : null,
        },
      });
      await this.referrals.createFor(tx, actor, requested, now);
      const result =
        approval.mode === 'auto' ? await this.confirmIn(tx, actor, requested, null) : requested;
      return view(result, booker.kind === 'patient');
    });
  }

  // --- the center -------------------------------------------------------------------------

  async respond(
    actor: Actor,
    access: EffectiveAccess,
    appointmentId: string,
    input: z.output<typeof respondAppointmentSchema>,
    now = new Date(),
  ): Promise<AppointmentView> {
    return this.asCenter(actor, access, appointmentId, async (tx, row, auditActor) => {
      if (row.status === 'requested' && row.startsAt <= now) {
        throw new ConflictException({ error: 'appointment_started' });
      }
      if (input.decision === 'confirm') {
        return this.confirmIn(tx, auditActor, row, input.reason ?? null);
      }
      return moveAppointment(this.deps, tx, auditActor, row, 'rejected', { reason: input.reason });
    });
  }

  async cancelByCenter(
    actor: Actor,
    access: EffectiveAccess,
    appointmentId: string,
    reason: string,
  ): Promise<AppointmentView> {
    return this.asCenter(actor, access, appointmentId, (tx, row, auditActor) =>
      moveAppointment(this.deps, tx, auditActor, row, 'cancelled_by_center', { reason }),
    );
  }

  async checkIn(
    actor: Actor,
    access: EffectiveAccess,
    appointmentId: string,
    code: string,
    now = new Date(),
  ): Promise<AppointmentView> {
    const attempt = { wrong: false };
    const result = await this.asCenter(
      actor,
      access,
      appointmentId,
      async (tx, row, auditActor) => {
        if (row.status !== 'confirmed') {
          throw new ConflictException({
            error: 'invalid_transition',
            from: row.status,
            to: 'checked_in',
          });
        }
        if (row.checkInAttempts >= MAX_CHECK_IN_ATTEMPTS) {
          throw new ConflictException({ error: 'check_in_locked' });
        }
        const expected = Buffer.from(row.checkInCode ?? '');
        const given = Buffer.from(code);
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
          // Counted even though the answer is an error: the attempt must stay spent.
          attempt.wrong = true;
          const [counted] = await tx
            .update(appointments)
            .set({ checkInAttempts: row.checkInAttempts + 1 })
            .where(eq(appointments.id, row.id))
            .returning();
          return counted ?? row;
        }
        return moveAppointment(this.deps, tx, auditActor, row, 'checked_in', {
          set: { checkedInAt: now },
        });
      },
    );
    if (attempt.wrong) throw new BadRequestException({ error: 'wrong_check_in_code' });
    return result;
  }

  async markExamined(
    actor: Actor,
    access: EffectiveAccess,
    appointmentId: string,
  ): Promise<AppointmentView> {
    return this.asCenter(actor, access, appointmentId, (tx, row, auditActor) =>
      moveAppointment(this.deps, tx, auditActor, row, 'examined'),
    );
  }

  /** Only once the time has come; the patient may dispute it (doc 08 §7). */
  async markNoShow(
    actor: Actor,
    access: EffectiveAccess,
    appointmentId: string,
    reason: string,
    now = new Date(),
  ): Promise<AppointmentView> {
    return this.asCenter(actor, access, appointmentId, (tx, row, auditActor) => {
      if (row.startsAt > now) throw new ConflictException({ error: 'appointment_not_started' });
      return moveAppointment(this.deps, tx, auditActor, row, 'no_show', { reason });
    });
  }

  /**
   * «Visit paid» at the center (doc 08 §7): once, within the quoted range, after check-in.
   * Not the lender's money, so no ledger entry. TODO(decision): a visit discount code.
   */
  async recordVisitPayment(
    actor: Actor,
    access: EffectiveAccess,
    appointmentId: string,
    input: z.output<typeof visitPaymentSchema>,
  ): Promise<{ appointmentId: string; amountRial: string }> {
    const amount = BigInt(input.amountRial);
    await this.asCenter(actor, access, appointmentId, async (tx, row, auditActor) => {
      if (row.status !== 'checked_in' && row.status !== 'examined') {
        throw new ConflictException({ error: 'not_checked_in' });
      }
      if (row.tariffIsFree) throw new ConflictException({ error: 'visit_is_free' });
      if (amount < row.tariffMinAmountRial || amount > row.tariffMaxAmountRial) {
        throw new BadRequestException({
          error: 'amount_out_of_range',
          minAmountRial: row.tariffMinAmountRial.toString(),
          maxAmountRial: row.tariffMaxAmountRial.toString(),
        });
      }
      try {
        await tx.insert(visitPayments).values({
          appointmentId: row.id,
          amountRial: amount,
          reason: input.reason ?? null,
          createdBy: actor.accountId,
        });
      } catch (error) {
        if (pgCode(error) === '23505') throw new ConflictException({ error: 'visit_already_paid' });
        throw error;
      }
      await this.audit.record(
        {
          actor: auditActor,
          action: 'booking.visit_paid',
          entityType: 'appointment',
          entityId: row.id,
          after: { amountRial: amount.toString() },
          reason: input.reason ?? null,
        },
        tx,
      );
      return row;
    });
    return { appointmentId, amountRial: amount.toString() };
  }

  // --- the patient ------------------------------------------------------------------------

  async cancelByPatient(
    actor: Actor,
    accountId: string,
    appointmentId: string,
    reason: string,
    now = new Date(),
  ): Promise<AppointmentView> {
    const cutoff = (await this.config.resolve('booking.patient_cancel_cutoff_minutes')).value;
    return this.db.transaction(async (tx) => {
      const row = await lockAppointment(tx, appointmentId);
      if (!row || !(await this.ownedBy(row, accountId))) throw notFound();
      if (row.status === 'confirmed') this.requireBeforeCutoff(row, cutoff, now);
      const moved = await moveAppointment(this.deps, tx, actor, row, 'cancelled_by_patient', {
        reason,
      });
      return view(moved, true);
    });
  }

  async disputeNoShow(
    actor: Actor,
    accountId: string,
    appointmentId: string,
    reason: string,
  ): Promise<{ appointmentId: string; disputed: true }> {
    await this.db.transaction(async (tx) => {
      const row = await lockAppointment(tx, appointmentId);
      if (!row || !(await this.ownedBy(row, accountId))) throw notFound();
      if (row.status !== 'no_show') throw new ConflictException({ error: 'not_a_no_show' });
      try {
        await tx
          .insert(noShowDisputes)
          .values({ appointmentId: row.id, reason, createdBy: actor.accountId });
      } catch (error) {
        if (pgCode(error) === '23505') throw new ConflictException({ error: 'already_disputed' });
        throw error;
      }
      await this.audit.record(
        {
          actor,
          action: 'booking.no_show_disputed',
          entityType: 'appointment',
          entityId: row.id,
          reason,
        },
        tx,
      );
    });
    return { appointmentId, disputed: true };
  }

  /**
   * TODO(decision): how long a patient may dispute, and what a no-show nobody disputed
   * weighs; nothing scores behaviour yet (doc 08 §7).
   */
  async resolveNoShowDispute(
    actor: Actor,
    access: EffectiveAccess,
    appointmentId: string,
    input: z.output<typeof resolveNoShowDisputeSchema>,
    now = new Date(),
  ): Promise<{ appointmentId: string; outcome: string }> {
    if (!access.permissions.has('booking.resolve_no_show_dispute')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    await this.db.transaction(async (tx) => {
      const row = await lockAppointment(tx, appointmentId);
      if (!row) throw notFound();
      await this.calendars.visibleWorkplace(tx, access, row.workplaceId).catch(() => {
        throw notFound();
      });
      const [dispute] = await tx
        .select()
        .from(noShowDisputes)
        .where(eq(noShowDisputes.appointmentId, row.id))
        .for('update');
      if (!dispute) throw new NotFoundException({ error: 'dispute_not_found' });
      if (dispute.outcome !== null)
        throw new ConflictException({ error: 'dispute_already_decided' });
      await tx
        .update(noShowDisputes)
        .set({
          outcome: input.outcome,
          resolutionReason: input.reason,
          resolvedBy: actor.accountId,
          resolvedAt: now,
        })
        .where(eq(noShowDisputes.id, dispute.id));
      await this.outbox.publish(
        {
          type: 'booking.no_show_dispute_resolved',
          aggregateType: 'appointment',
          aggregateId: row.id,
          payload: {
            appointmentId: row.id,
            workplaceId: row.workplaceId,
            doctorId: row.doctorId,
            caseId: row.caseId,
            outcome: input.outcome,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          actor,
          action: 'booking.no_show_dispute_resolved',
          entityType: 'appointment',
          entityId: row.id,
          before: { outcome: null },
          after: { outcome: input.outcome },
          reason: input.reason,
        },
        tx,
      );
    });
    return { appointmentId, outcome: input.outcome };
  }

  // --- moving an appointment -----------------------------------------------------------

  /**
   * Another slot of the same workplace (doc 08 §7): the old appointment becomes
   * `rescheduled` and a new one points back to it, in one transaction. The price stays the
   * one quoted at booking unless the service changes. Moved by the center, the new one is
   * confirmed; by the patient (until the cancellation cutoff), it follows the workplace's
   * approval mode now in force. Its referral supersedes the old one and keeps the first
   * referral date (task 2-6 decision 4).
   */
  async reschedule(
    actor: Actor,
    by:
      | { readonly kind: 'patient'; readonly accountId: string }
      | { readonly kind: 'center'; readonly access: EffectiveAccess },
    appointmentId: string,
    input: {
      readonly startsAt: Date;
      readonly serviceCode?: string | undefined;
      readonly reason: string;
    },
    now = new Date(),
  ): Promise<AppointmentView> {
    const current = await this.readRow(appointmentId);
    const workplace = await this.directory.workplace(current.workplaceId);
    if (!workplace) throw notFound();
    if (by.kind === 'center')
      await this.staffWorkplace(by.access, 'booking.manage_appointments', workplace.id);
    if (!isBookable(workplace)) throw new ConflictException({ error: 'workplace_not_bookable' });
    const serviceCode = input.serviceCode ?? current.serviceCode;
    const slot = await this.findSlot(workplace, serviceCode, input.startsAt, now, current.id);
    const quote =
      serviceCode === current.serviceCode
        ? null
        : await this.tariffs.quote(workplace.id, serviceCode, now);
    if (serviceCode !== current.serviceCode && !quote) {
      throw new ConflictException({ error: 'service_not_priced' });
    }
    const [approval, sla, cutoff] = await Promise.all([
      this.calendars.approvalModeOf(workplace.id),
      this.config.resolve('booking.center_approval_sla_minutes'),
      this.config.resolve('booking.patient_cancel_cutoff_minutes'),
    ]);
    const auditActor = this.onBehalf(actor, workplace, by.kind === 'center');

    try {
      return await this.db.transaction(async (tx) => {
        const row = await lockAppointment(tx, appointmentId);
        if (!row) throw notFound();
        if (by.kind === 'patient') {
          if (!(await this.ownedBy(row, by.accountId))) throw notFound();
          if (row.status === 'confirmed') this.requireBeforeCutoff(row, cutoff.value, now);
        }
        // The old time is given up first so the new one may overlap it; the moves are
        // recorded after the insert, which may wait on another booking and must not hold
        // the audit lock meanwhile.
        if (!canTransition(row.status, 'rescheduled')) {
          throw new ConflictException({
            error: 'invalid_transition',
            from: row.status,
            to: 'rescheduled',
          });
        }
        const [old] = await tx
          .update(appointments)
          .set({ status: 'rescheduled' })
          .where(eq(appointments.id, row.id))
          .returning();
        if (!old) throw notFound();
        const status: AppointmentStatus =
          by.kind === 'center' || approval.mode === 'auto' ? 'confirmed' : 'requested';
        const [fresh] = await tx
          .insert(appointments)
          .values({
            workplaceId: old.workplaceId,
            doctorId: old.doctorId,
            patientAccountId: old.patientAccountId,
            mobile: old.mobile,
            personId: old.personId,
            caseId: old.caseId,
            serviceCode,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            status,
            channel: old.channel,
            holdExpiresAt: now,
            approvalMode: by.kind === 'center' ? old.approvalMode : approval.mode,
            approvalModeVersionId:
              by.kind === 'center' ? old.approvalModeVersionId : approval.versionId,
            approvalDueAt:
              status === 'requested' ? new Date(now.getTime() + sla.value * MINUTE_MS) : null,
            tariffVersionId: quote?.tariffVersionId ?? old.tariffVersionId,
            tariffIsFree: quote?.isFree ?? old.tariffIsFree,
            tariffMinAmountRial: quote?.minAmountRial ?? old.tariffMinAmountRial,
            tariffMaxAmountRial: quote?.maxAmountRial ?? old.tariffMaxAmountRial,
            checkInCode: status === 'confirmed' ? newCheckInCode() : null,
            rescheduledFromId: old.id,
            createdBy: actor.accountId,
          })
          .onConflictDoNothing()
          .returning();
        // Taken meanwhile: the whole move rolls back and the old appointment stands.
        if (!fresh) throw new ConflictException({ error: 'slot_taken' });
        await recordMove(this.deps, tx, auditActor, old, row.status, input.reason);
        await this.outbox.publish(
          {
            type: 'booking.appointment_rescheduled',
            aggregateType: 'appointment',
            aggregateId: old.id,
            payload: {
              appointmentId: old.id,
              workplaceId: old.workplaceId,
              doctorId: old.doctorId,
              caseId: old.caseId,
              newAppointmentId: fresh.id,
            },
          },
          tx,
        );
        const previous = await this.referrals.ofAppointment(tx, old.id);
        await recordMove(this.deps, tx, auditActor, fresh, null, input.reason);
        await this.referrals.createFor(tx, auditActor, fresh, now, previous);
        return view(fresh, by.kind === 'patient');
      });
    } catch (error) {
      if (pgCode(error) === '23P01') throw new ConflictException({ error: 'slot_taken' });
      throw error;
    }
  }

  // --- reading ------------------------------------------------------------------------------

  /**
   * The patient's appointments, filtered and paged on the server (task 2-11): upcoming
   * (soonest first) or past (latest first), a status, and a range of Tehran days; each with
   * the doctor's, place's and service's names, which the page shows.
   */
  async listForPatient(
    accountId: string,
    query: PatientAppointmentQuery = {},
    now = new Date(),
  ): Promise<PatientAppointmentPage> {
    const persons = await this.patientPersonIds(accountId);
    const conditions = [
      persons.length > 0
        ? or(eq(appointments.patientAccountId, accountId), inArray(appointments.personId, persons))
        : eq(appointments.patientAccountId, accountId),
    ];
    if (query.when === 'upcoming') conditions.push(gte(appointments.startsAt, now));
    if (query.when === 'past') conditions.push(lt(appointments.startsAt, now));
    if (query.status) conditions.push(eq(appointments.status, query.status));
    if (query.from) conditions.push(gte(appointments.startsAt, tehranMidnight(query.from)));
    if (query.to) conditions.push(lt(appointments.startsAt, tehranMidnight(query.to, 1)));
    const where = and(...conditions);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [rows, [counted]] = await Promise.all([
      this.db
        .select()
        .from(appointments)
        .where(where)
        .orderBy(
          query.when === 'upcoming' ? asc(appointments.startsAt) : desc(appointments.startsAt),
          asc(appointments.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ n: count() }).from(appointments).where(where),
    ]);
    const places = new Map<string, WorkplaceRecord | null>();
    for (const id of new Set(rows.map((r) => r.workplaceId))) {
      places.set(id, await this.directory.workplace(id));
    }
    const services = await this.directory.serviceNames(rows.map((r) => r.serviceCode));
    return {
      page,
      pageSize,
      total: counted?.n ?? 0,
      items: rows.map((r) => {
        const place = places.get(r.workplaceId) ?? null;
        return {
          ...view(r, true),
          // A removed workplace or doctor still shows the appointment, with what is known.
          doctor: { id: r.doctorId, name: place?.doctorName ?? '' },
          placeName: place?.placeName ?? null,
          serviceName: services.get(r.serviceCode) ?? r.serviceCode,
        };
      }),
    };
  }

  async getForPatient(accountId: string, appointmentId: string): Promise<AppointmentView> {
    const row = await this.readRow(appointmentId);
    if (!(await this.ownedBy(row, accountId))) throw notFound();
    return view(row, true);
  }

  /** A workplace's appointments between two Tehran days (inclusive). */
  async listForWorkplace(
    access: EffectiveAccess,
    workplaceId: string,
    query: z.output<typeof appointmentListQuerySchema>,
  ): Promise<WorkplaceAppointment[]> {
    const workplace = await this.staffWorkplace(access, 'booking.read_appointments', workplaceId);
    const from = tehranMidnight(query.from);
    const to = tehranMidnight(query.to, 1);
    const rows = await this.db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.workplaceId, workplace.id),
          gte(appointments.startsAt, from),
          lt(appointments.startsAt, to),
          query.status ? eq(appointments.status, query.status) : undefined,
        ),
      )
      .orderBy(asc(appointments.startsAt));
    const services = await this.directory.serviceNames(rows.map((r) => r.serviceCode));
    return rows.map((r) => ({
      ...view(r),
      serviceName: services.get(r.serviceCode) ?? r.serviceCode,
      patient: { mobileMasked: maskedMobile(r.mobile) },
    }));
  }

  async getForStaff(access: EffectiveAccess, appointmentId: string): Promise<AppointmentView> {
    const row = await this.readRow(appointmentId);
    await this.staffWorkplace(access, 'booking.read_appointments', row.workplaceId).catch(() => {
      throw notFound();
    });
    return view(row);
  }

  /** An advisor's view of the appointments of a case they hold (doc 04: own patients). */
  async listForCase(
    actor: Actor,
    access: EffectiveAccess,
    caseId: string,
  ): Promise<AppointmentView[]> {
    if (!access.permissions.has('booking.book_for_patient')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    if (!UUID.test(caseId) || (await this.leads.assigneeOf(caseId)) !== actor.accountId) {
      throw new NotFoundException({ error: 'case_not_found' });
    }
    const rows = await this.db
      .select()
      .from(appointments)
      .where(eq(appointments.caseId, caseId))
      .orderBy(desc(appointments.startsAt));
    return rows.map((r) => view(r));
  }

  async pendingManual(access: EffectiveAccess, workplaceId: string): Promise<PendingManualView> {
    const workplace = await this.staffWorkplace(access, 'booking.read_appointments', workplaceId);
    const [mode, [row]] = await Promise.all([
      this.calendars.approvalModeOf(workplace.id),
      this.db
        .select({ n: count() })
        .from(appointments)
        .where(
          and(
            eq(appointments.workplaceId, workplace.id),
            eq(appointments.status, 'requested'),
            eq(appointments.approvalMode, 'manual'),
          ),
        ),
    ]);
    return { approvalMode: mode.mode, waitingForManualApproval: row?.n ?? 0 };
  }

  // --- helpers ------------------------------------------------------------------------------

  private get deps() {
    return { audit: this.audit, outbox: this.outbox };
  }

  private async confirmIn(
    tx: Tx,
    actor: Actor,
    row: AppointmentRow,
    reason: string | null,
  ): Promise<AppointmentRow> {
    return moveAppointment(this.deps, tx, actor, row, 'confirmed', {
      reason,
      set: { checkInCode: newCheckInCode() },
    });
  }

  /** Runs `work` on the locked appointment for a staff member whose scope covers it. */
  private async asCenter(
    actor: Actor,
    access: EffectiveAccess,
    appointmentId: string,
    work: (tx: Tx, row: AppointmentRow, auditActor: Actor) => Promise<AppointmentRow>,
  ): Promise<AppointmentView> {
    if (!access.permissions.has('booking.manage_appointments')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    return this.db.transaction(async (tx) => {
      const row = await lockAppointment(tx, appointmentId);
      if (!row) throw notFound();
      const workplace = await this.calendars
        .visibleWorkplace(tx, access, row.workplaceId)
        .catch(() => {
          throw notFound();
        });
      if (workplace.centerStatus === 'terminated') {
        throw new ConflictException({ error: 'center_terminated' });
      }
      return view(await work(tx, row, this.onBehalf(actor, workplace, true)));
    });
  }

  /** «On behalf of» the doctor unless the doctor acts (task 2-3). */
  private onBehalf(actor: Actor, workplace: WorkplaceRecord, staff: boolean): Actor {
    if (!staff || workplace.doctorAccountId === actor.accountId) return actor;
    return { ...actor, onBehalfOfDoctorId: workplace.doctorId };
  }

  private async staffWorkplace(
    access: EffectiveAccess,
    permission: 'booking.read_appointments' | 'booking.manage_appointments',
    workplaceId: string,
  ): Promise<WorkplaceRecord> {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
    return this.calendars.visibleWorkplace(this.db, access, workplaceId);
  }

  private async findSlot(
    workplace: WorkplaceRecord,
    serviceCode: string,
    startsAt: Date,
    now: Date,
    excludeAppointmentId?: string,
  ) {
    const day = tehranDayOf(startsAt);
    const slots = await this.availability.freeSlots(workplace, day, day, now, excludeAppointmentId);
    const slot = slots.find(
      (s) => s.startsAt.getTime() === startsAt.getTime() && s.serviceCodes.includes(serviceCode),
    );
    if (!slot) throw new ConflictException({ error: 'slot_not_available' });
    return slot;
  }

  /**
   * Gives back the doctor's holds past their time that meet this slot, and the patient's
   * own earlier holds (one hold at a time), each moved to `expired` with its record.
   */
  private async expireStaleHolds(
    doctorId: string,
    from: Date,
    to: Date,
    now: Date,
    booker: Booker,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const stale = await tx
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.status, 'held'),
            or(
              and(
                eq(appointments.doctorId, doctorId),
                lte(appointments.holdExpiresAt, now),
                lt(appointments.startsAt, to),
                sql`${appointments.endsAt} > ${from}`,
              ),
              booker.kind === 'patient'
                ? eq(appointments.patientAccountId, booker.accountId)
                : undefined,
            ),
          ),
        )
        .for('update', { skipLocked: true });
      for (const row of stale) {
        await moveAppointment(this.deps, tx, BOOKING_SYSTEM_ACTOR, row, 'expired', {
          reason: row.holdExpiresAt <= now ? 'hold_lapsed' : 'replaced_by_new_hold',
        });
      }
    });
  }

  private requireBeforeCutoff(row: AppointmentRow, cutoffMinutes: number, now: Date) {
    if (row.startsAt.getTime() - now.getTime() < cutoffMinutes * MINUTE_MS) {
      throw new ConflictException({ error: 'too_late_to_change', cutoffMinutes });
    }
  }

  private async patientMobile(accountId: string): Promise<string> {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient' || account.status !== 'active' || !account.mobile) {
      throw new ForbiddenException({ error: 'patients_only' });
    }
    return account.mobile;
  }

  /** The persons whose appointments this patient sees: theirs and everyone merged in. */
  private async patientPersonIds(accountId: string): Promise<string[]> {
    const account = await this.accounts.find(accountId);
    if (!account?.personId) return [];
    return this.leads.samePersonIds(await this.leads.canonicalPersonId(account.personId));
  }

  private async ownedBy(row: AppointmentRow, accountId: string): Promise<boolean> {
    if (row.patientAccountId === accountId) return true;
    if (row.personId === null) return false;
    return (await this.patientPersonIds(accountId)).includes(row.personId);
  }

  /** The hold's maker: the patient's own account, or the advisor who held it. */
  private madeBy(
    row: AppointmentRow,
    booker: { readonly kind: 'patient' | 'advisor'; readonly accountId: string },
  ): boolean {
    return booker.kind === 'patient'
      ? row.patientAccountId === booker.accountId
      : row.channel === 'advisor' && row.createdBy === booker.accountId;
  }

  private async readRow(appointmentId: string): Promise<AppointmentRow> {
    if (!UUID.test(appointmentId)) throw notFound();
    const [row] = await this.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointmentId));
    if (!row) throw notFound();
    return row;
  }

  private async byIdempotencyKey(accountId: string, key: string): Promise<AppointmentRow | null> {
    const [row] = await this.db
      .select()
      .from(appointments)
      .where(and(eq(appointments.createdBy, accountId), eq(appointments.idempotencyKey, key)));
    return row ?? null;
  }
}

/** The instant a Tehran day (Gregorian YYYY-MM-DD) starts, or `plusDays` later. */
function tehranMidnight(day: string, plusDays = 0): Date {
  const [year, month, date] = day.split('-').map(Number);
  let jalali = gregorianToJalali({ year: year ?? 0, month: month ?? 0, day: date ?? 0 });
  for (let i = 0; i < plusDays; i++) jalali = nextJalaliDay(jalali);
  return fromJalali(jalali);
}
