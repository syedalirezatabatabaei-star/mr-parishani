import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { AUDIT_LOG, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import { eventIds, moveAppointment, type AppointmentRow, type Tx } from './appointment-lifecycle';
import { appointmentNotices, appointments } from './booking.schema';

const MINUTE_MS = 60_000;
/** Rows per pass; the next minute takes the rest. */
const BATCH = 200;

const SWEEPER_ACTOR = { accountId: null, sessionId: null, ip: null, roles: ['booking'] };

export interface SweepResult {
  readonly holdsExpired: number;
  readonly requestsExpired: number;
  readonly overdue: number;
  readonly reminders: number;
}

/**
 * What time does to appointments (task 2-6, doc 08 §7), run by the worker every minute:
 *
 * - a hold past its time is `expired` (the slot was already free for others: busy time
 *   ignores it, test 2);
 * - a request the center never answered is `expired` once its start has come
 *   (task 2-6 decision 5);
 * - a manual request past `booking.center_approval_sla_minutes` is announced once
 *   (`booking.appointment_approval_overdue`), so the supporting advisor is told;
 * - each reminder of `booking.reminder_offsets_minutes` is announced once per confirmed
 *   appointment, unless it was confirmed too late for that reminder to make sense.
 *
 * Each row in its own transaction, skipping rows another pass holds: moves are audited
 * one by one and a failure touches nothing else.
 */
@Injectable()
export class AppointmentSweeper {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  async run(now = new Date()): Promise<SweepResult> {
    const offsets = (await this.config.resolve('booking.reminder_offsets_minutes')).value;
    return {
      holdsExpired: await this.expire(
        and(eq(appointments.status, 'held'), lte(appointments.holdExpiresAt, now)),
        'hold_lapsed',
      ),
      requestsExpired: await this.expire(
        and(eq(appointments.status, 'requested'), lte(appointments.startsAt, now)),
        'center_never_answered',
      ),
      overdue: await this.announceOverdue(now),
      reminders: (
        await Promise.all(offsets.map((offset) => this.announceReminders(now, offset)))
      ).reduce((a, b) => a + b, 0),
    };
  }

  private async expire(where: ReturnType<typeof and>, reason: string): Promise<number> {
    const due = await this.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(where)
      .limit(BATCH);
    let moved = 0;
    for (const { id } of due) {
      const done = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(appointments)
          .where(and(eq(appointments.id, id), where))
          .for('update', { skipLocked: true });
        if (!row) return false;
        await moveAppointment(
          { audit: this.audit, outbox: this.outbox },
          tx,
          SWEEPER_ACTOR,
          row,
          'expired',
          { reason },
        );
        return true;
      });
      if (done) moved++;
    }
    return moved;
  }

  private async announceOverdue(now: Date): Promise<number> {
    const due = await this.db
      .select()
      .from(appointments)
      .leftJoin(
        appointmentNotices,
        and(
          eq(appointmentNotices.appointmentId, appointments.id),
          eq(appointmentNotices.kind, 'approval_overdue'),
        ),
      )
      .where(
        and(
          eq(appointments.status, 'requested'),
          eq(appointments.approvalMode, 'manual'),
          lte(appointments.approvalDueAt, now),
          gt(appointments.startsAt, now),
          isNull(appointmentNotices.id),
        ),
      )
      .limit(BATCH);
    let announced = 0;
    for (const { appointments: row } of due) {
      if (
        await this.announce(row, 'approval_overdue', 0, 'booking.appointment_approval_overdue', {})
      ) {
        announced++;
      }
    }
    return announced;
  }

  private async announceReminders(now: Date, offsetMinutes: number): Promise<number> {
    const offset = offsetMinutes * MINUTE_MS;
    const due = await this.db
      .select()
      .from(appointments)
      .leftJoin(
        appointmentNotices,
        and(
          eq(appointmentNotices.appointmentId, appointments.id),
          eq(appointmentNotices.kind, 'reminder'),
          eq(appointmentNotices.offsetMinutes, offsetMinutes),
        ),
      )
      .where(
        and(
          eq(appointments.status, 'confirmed'),
          gt(appointments.startsAt, now),
          lte(appointments.startsAt, new Date(now.getTime() + offset)),
          // Booked inside this reminder's window: the confirmation said it all.
          sql`${appointments.createdAt} < ${appointments.startsAt} - make_interval(mins => ${offsetMinutes})`,
          isNull(appointmentNotices.id),
        ),
      )
      .limit(BATCH);
    let announced = 0;
    for (const { appointments: row } of due) {
      if (
        await this.announce(row, 'reminder', offsetMinutes, 'booking.appointment_reminder_due', {
          offsetMinutes,
        })
      ) {
        announced++;
      }
    }
    return announced;
  }

  /** Once per (appointment, kind, offset): the notice row's unique key decides. */
  private announce(
    row: AppointmentRow,
    kind: 'reminder' | 'approval_overdue',
    offsetMinutes: number,
    type: string,
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx: Tx) => {
      const inserted = await tx
        .insert(appointmentNotices)
        .values({ appointmentId: row.id, kind, offsetMinutes })
        .onConflictDoNothing()
        .returning({ id: appointmentNotices.id });
      if (inserted.length === 0) return false;
      await this.outbox.publish(
        {
          type,
          aggregateType: 'appointment',
          aggregateId: row.id,
          payload: { ...eventIds(row), ...extra },
        },
        tx,
      );
      return true;
    });
  }
}
