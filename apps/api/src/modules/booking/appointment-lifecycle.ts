import { ConflictException } from '@nestjs/common';
import { canTransition, type AppointmentStatus } from '@sepehr/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Actor, AuditLog } from '../../common/audit/audit.port';
import type { OutboxPort } from '../../common/events/outbox.port';
import type { Database } from '../../db/database.module';
import { appointments, appointmentStatusChanges } from './booking.schema';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type AppointmentRow = typeof appointments.$inferSelect;

/** The event of each move, where it has one (doc 08 §14). */
const EVENT_OF: Partial<Record<AppointmentStatus, string>> = {
  held: 'booking.appointment_held',
  requested: 'booking.appointment_requested',
  confirmed: 'booking.appointment_confirmed',
  rejected: 'booking.appointment_rejected',
  expired: 'booking.appointment_expired',
  cancelled_by_patient: 'booking.appointment_cancelled',
  cancelled_by_center: 'booking.appointment_cancelled',
  checked_in: 'booking.appointment_checked_in',
  examined: 'booking.appointment_examined',
  no_show: 'booking.appointment_no_show',
};

export const pgCode = (error: unknown): string | undefined => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
};

/** The ids an appointment event carries (rule 30: never the mobile). */
export const eventIds = (row: AppointmentRow) => ({
  appointmentId: row.id,
  workplaceId: row.workplaceId,
  doctorId: row.doctorId,
  caseId: row.caseId,
});

/** The row, locked for this transaction; null if there is none. */
export async function lockAppointment(tx: Tx, id: string): Promise<AppointmentRow | null> {
  const [row] = await tx.select().from(appointments).where(eq(appointments.id, id)).for('update');
  return row ?? null;
}

/**
 * The one way an appointment's status changes (rule 8): the move must be one of
 * APPOINTMENT_TRANSITIONS (the database checks the same pairs), it is recorded with who
 * and why, audited, and its event published, all in `tx`. `set` carries the other columns
 * the move fills in.
 */
export async function moveAppointment(
  deps: { readonly audit: AuditLog; readonly outbox: OutboxPort },
  tx: Tx,
  actor: Actor,
  row: AppointmentRow,
  to: AppointmentStatus,
  options: {
    readonly reason?: string | null;
    readonly set?: Partial<typeof appointments.$inferInsert>;
    readonly extraPayload?: Record<string, unknown>;
  } = {},
): Promise<AppointmentRow> {
  if (!canTransition(row.status, to)) {
    throw new ConflictException({ error: 'invalid_transition', from: row.status, to });
  }
  const [moved] = await tx
    .update(appointments)
    .set({ ...options.set, status: to })
    .where(eq(appointments.id, row.id))
    .returning();
  if (!moved) throw new Error(`appointment ${row.id} not updated`);
  await recordMove(
    deps,
    tx,
    actor,
    moved,
    row.status,
    options.reason ?? null,
    options.extraPayload,
  );
  return moved;
}

/** The history, audit and event of a move, or of a new appointment (`from` null). */
export async function recordMove(
  deps: { readonly audit: AuditLog; readonly outbox: OutboxPort },
  tx: Tx,
  actor: Actor,
  row: AppointmentRow,
  from: AppointmentStatus | null,
  reason: string | null,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(appointmentStatusChanges).values({
    appointmentId: row.id,
    fromStatus: from,
    toStatus: row.status,
    actorAccountId: actor.accountId,
    reason,
  });
  const type = EVENT_OF[row.status];
  if (type) {
    const by =
      row.status === 'cancelled_by_patient'
        ? { by: 'patient' }
        : row.status === 'cancelled_by_center'
          ? { by: 'center' }
          : {};
    await deps.outbox.publish(
      {
        type,
        aggregateType: 'appointment',
        aggregateId: row.id,
        payload: { ...eventIds(row), ...by, ...extraPayload },
      },
      tx,
    );
  }
  // Last: the audit chain's lock is held from here to the commit (see AuditService).
  await deps.audit.record(
    {
      actor,
      action: from === null ? 'booking.appointment_created' : 'booking.appointment_moved',
      entityType: 'appointment',
      entityId: row.id,
      before: from === null ? null : { status: from },
      after: {
        status: row.status,
        workplaceId: row.workplaceId,
        startsAt: row.startsAt.toISOString(),
        serviceCode: row.serviceCode,
      },
      reason,
    },
    tx,
  );
}

/** Takes one appointment-scoped advisory lock (a check-in's attempts, a notice). */
export async function lockKey(tx: Tx, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
