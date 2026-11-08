import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { AppointmentStatus, ReferralChannel } from '@sepehr/contracts';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import type {
  ReferralDirectory,
  ReferralRecord,
} from '../../common/booking/referral-directory.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../db/database.module';
import type { AppointmentRow, Tx } from './appointment-lifecycle';
import { referrals } from './booking.schema';

type ReferralRow = typeof referrals.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReferralView {
  readonly id: string;
  readonly appointmentId: string;
  /** The person of the referral's day. */
  readonly personId: string;
  /** The person that one is now, after any merge (task 2-5b). */
  readonly currentPersonId: string;
  readonly caseId: string | null;
  readonly doctorId: string;
  readonly workplaceId: string;
  readonly channel: ReferralChannel;
  readonly referredAt: string;
  readonly supersedesReferralId: string | null;
}

/**
 * Referrals (doc 08 §8, ADR-027): exactly one per appointment made through Sepehr,
 * written in the appointment's own transaction and never changed or removed (the table
 * rejects both; there is no method for either). The basis of the cash-service commission
 * of phase 5, whose attribution window is TODO(decision) (doc 09 open item 5).
 *
 * A referral keeps the person and case of its day. When persons are merged (task 2-5b) the
 * case moves but keeps its id, so the referral stays true; readers follow the merge to the
 * current person. A rescheduled appointment gets its own referral that supersedes the
 * previous one and keeps the first referral date of the chain (task 2-6 decision 4).
 */
@Injectable()
export class ReferralService implements ReferralDirectory {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
  ) {}

  /** In the appointment's transaction, once it has its person. */
  async createFor(
    tx: Tx,
    actor: Actor,
    appointment: AppointmentRow,
    now: Date,
    supersedes: ReferralRow | null = null,
  ): Promise<ReferralRow> {
    if (appointment.personId === null) throw new Error('a referral needs the person');
    const [row] = await tx
      .insert(referrals)
      .values({
        appointmentId: appointment.id,
        personId: appointment.personId,
        caseId: appointment.caseId,
        doctorId: appointment.doctorId,
        workplaceId: appointment.workplaceId,
        channel: appointment.channel,
        referredAt: supersedes?.referredAt ?? now,
        supersedesReferralId: supersedes?.id ?? null,
      })
      .returning();
    if (!row) throw new Error('referral not inserted');
    await this.outbox.publish(
      {
        type: 'booking.referral_created',
        aggregateType: 'referral',
        aggregateId: row.id,
        payload: {
          referralId: row.id,
          appointmentId: row.appointmentId,
          personId: row.personId,
          caseId: row.caseId,
          supersedesReferralId: row.supersedesReferralId,
        },
      },
      tx,
    );
    await this.audit.record(
      {
        actor,
        action: 'booking.referral_created',
        entityType: 'referral',
        entityId: row.id,
        after: {
          appointmentId: row.appointmentId,
          personId: row.personId,
          caseId: row.caseId,
          channel: row.channel,
          referredAt: row.referredAt.toISOString(),
          supersedesReferralId: row.supersedesReferralId,
        },
      },
      tx,
    );
    return row;
  }

  /** REFERRAL_DIRECTORY: the referral of an appointment, for the proforma (task 3-4). */
  async forAppointment(appointmentId: string, tx?: SqlExecutor): Promise<ReferralRecord | null> {
    if (!UUID.test(appointmentId)) return null;
    const result = await (tx ?? this.db).execute(sql`
      SELECT r.id, r.appointment_id, r.person_id, r.case_id, r.doctor_id, r.workplace_id,
        r.referred_at, a.status AS appointment_status
      FROM referrals r JOIN appointments a ON a.id = r.appointment_id
      WHERE r.appointment_id = ${appointmentId}::uuid`);
    const row = result.rows[0];
    if (!row) return null;
    return {
      referralId: row['id'] as string,
      appointmentId: row['appointment_id'] as string,
      personId: row['person_id'] as string,
      caseId: (row['case_id'] as string | null) ?? null,
      doctorId: row['doctor_id'] as string,
      workplaceId: row['workplace_id'] as string,
      referredAt: new Date(row['referred_at'] as string | Date),
      appointmentStatus: row['appointment_status'] as AppointmentStatus,
    };
  }

  async referral(referralId: string, tx?: SqlExecutor): Promise<ReferralRecord | null> {
    if (!UUID.test(referralId)) return null;
    const result = await (tx ?? this.db).execute(sql`
      SELECT r.id, r.appointment_id, r.person_id, r.case_id, r.doctor_id, r.workplace_id,
        r.referred_at, a.status AS appointment_status
      FROM referrals r JOIN appointments a ON a.id = r.appointment_id
      WHERE r.id = ${referralId}::uuid`);
    const row = result.rows[0];
    if (!row) return null;
    return {
      referralId: row['id'] as string,
      appointmentId: row['appointment_id'] as string,
      personId: row['person_id'] as string,
      caseId: (row['case_id'] as string | null) ?? null,
      doctorId: row['doctor_id'] as string,
      workplaceId: row['workplace_id'] as string,
      referredAt: new Date(row['referred_at'] as string | Date),
      appointmentStatus: row['appointment_status'] as AppointmentStatus,
    };
  }

  async ofAppointment(tx: Tx | Database, appointmentId: string): Promise<ReferralRow | null> {
    const [row] = await tx
      .select()
      .from(referrals)
      .where(eq(referrals.appointmentId, appointmentId));
    return row ?? null;
  }

  /**
   * Referrals made between two instants, for Sepehr's global scope (the commission is
   * Sepehr's business, not a center's).
   */
  async list(access: EffectiveAccess, from: Date, to: Date): Promise<ReferralView[]> {
    if (
      !access.permissions.has('booking.read_referrals') ||
      !access.scopes.some((s) => s.kind === 'global')
    ) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const rows = await this.db
      .select()
      .from(referrals)
      .where(and(gte(referrals.createdAt, from), lt(referrals.createdAt, to)))
      .orderBy(asc(referrals.createdAt))
      .limit(5000);
    const current = new Map<string, string>();
    for (const personId of new Set(rows.map((r) => r.personId))) {
      current.set(personId, await this.leads.canonicalPersonId(personId));
    }
    return rows.map((r) => ({
      id: r.id,
      appointmentId: r.appointmentId,
      personId: r.personId,
      currentPersonId: current.get(r.personId) ?? r.personId,
      caseId: r.caseId,
      doctorId: r.doctorId,
      workplaceId: r.workplaceId,
      channel: r.channel,
      referredAt: r.referredAt.toISOString(),
      supersedesReferralId: r.supersedesReferralId,
    }));
  }
}
