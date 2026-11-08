import { Inject, Injectable } from '@nestjs/common';
import { ACTIVE_APPOINTMENT_STATUSES, type BusyInterval } from '@sepehr/contracts';
import { and, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../db/database.module';
import { appointments } from './booking.schema';

/**
 * Time a doctor has already given away, at any of their workplaces: slots never overlap
 * it (doc 08 §6). Per doctor, not per workplace, so an appointment at one center also
 * closes the same time at another (task 2-5 decision 4), without saying where.
 */
export interface BusyTimeSource {
  busyFor(
    doctorId: string,
    from: Date,
    to: Date,
    options?: { readonly now?: Date; readonly excludeAppointmentId?: string },
  ): Promise<BusyInterval[]>;
}

export const BUSY_TIME = Symbol('BUSY_TIME');

/**
 * The doctor's live appointments (task 2-6): held, requested, confirmed, checked in or
 * examined. A hold past its expiry is free again at once (doc 08 §15 test 2), even before
 * the scheduler marks it expired.
 */
@Injectable()
export class AppointmentBusyTime implements BusyTimeSource {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async busyFor(
    doctorId: string,
    from: Date,
    to: Date,
    options: { readonly now?: Date; readonly excludeAppointmentId?: string } = {},
  ): Promise<BusyInterval[]> {
    const now = options.now ?? new Date();
    const rows = await this.db
      .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.doctorId, doctorId),
          inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
          sql`NOT (${appointments.status} = 'held' AND ${appointments.holdExpiresAt} <= ${now})`,
          lt(appointments.startsAt, to),
          gt(appointments.endsAt, from),
          options.excludeAppointmentId
            ? ne(appointments.id, options.excludeAppointmentId)
            : undefined,
        ),
      );
    return rows;
  }
}
