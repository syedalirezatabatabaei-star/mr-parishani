import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  computeSlots,
  gregorianDayOf,
  toJalali,
  type Slot,
  type slotQuerySchema,
} from '@sepehr/contracts';
import { and, between, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import type {
  BookableSlots,
  UpcomingSlot,
  UpcomingSlotsOptions,
} from '../../common/booking/bookable-slots.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
  type WorkplaceRecord,
} from '../../common/catalog/workplace-directory.port';
import {
  HOLIDAY_CALENDAR,
  type HolidayCalendarPort,
} from '../../common/config/holiday-calendar.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { availabilityExceptions } from './booking.schema';
import { BUSY_TIME, type BusyTimeSource } from './busy-time';
import { CalendarService } from './calendar.service';

const DAY_MS = 86_400_000;
/** Days computed at once while looking for the earliest free slots. */
const UPCOMING_WINDOW_DAYS = 14;

/** A Gregorian day YYYY-MM-DD plus `days`. */
const addDays = (day: string, days: number) =>
  new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

export interface SlotView {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly serviceCodes: readonly string[];
}

const slotView = (s: Slot): SlotView => ({
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  serviceCodes: s.serviceCodes,
});

/** Whether new appointments may be made at this workplace: a private practice, or an active center. */
export const isBookable = (workplace: WorkplaceRecord) =>
  workplace.centerStatus === null || workplace.centerStatus === 'active';

/** The Tehran day of an instant, as its Gregorian date YYYY-MM-DD. */
export const tehranDayOf = (at: Date) => gregorianDayOf(toJalali(at));

/**
 * Free slots of a doctor at one workplace (task 2-5, doc 08 §6): never stored, computed on
 * each request by the pure computeSlots() from the weekly schedule, the exceptions, the
 * holidays of the workplace's city (HOLIDAY_CALENDAR) and the doctor's busy time, from now
 * to the booking horizon. A workplace whose center takes no new appointments (suspended,
 * or not active yet) has none. A handful of queries and pure work: a month of one doctor
 * stays well within 200 ms (task 2-5 acceptance).
 */
@Injectable()
export class AvailabilityService implements BookableSlots {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(HOLIDAY_CALENDAR) private readonly holidays: HolidayCalendarPort,
    @Inject(BUSY_TIME) private readonly busy: BusyTimeSource,
    @Inject(WORKPLACE_DIRECTORY) private readonly directory: WorkplaceDirectory,
    private readonly calendars: CalendarService,
  ) {}

  /** For the panel: a workplace the caller's scope covers. */
  async slots(
    access: EffectiveAccess,
    workplaceId: string,
    query: z.output<typeof slotQuerySchema>,
    now = new Date(),
  ): Promise<SlotView[]> {
    if (!access.permissions.has('booking.read_calendar')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    const workplace = await this.calendars.visibleWorkplace(this.db, access, workplaceId);
    return (await this.freeSlots(workplace, query.from, query.to, now)).map(slotView);
  }

  /**
   * For patients and advisors (task 2-6): only the free times of a bookable workplace,
   * nothing about who took the others.
   */
  async bookableSlots(
    workplaceId: string,
    query: z.output<typeof slotQuerySchema>,
    now = new Date(),
  ): Promise<SlotView[]> {
    const workplace = await this.directory.workplace(workplaceId);
    if (!workplace) throw new NotFoundException({ error: 'workplace_not_found' });
    return (await this.freeSlots(workplace, query.from, query.to, now)).map(slotView);
  }

  /**
   * BOOKABLE_SLOTS (task 2-7): the earliest free slots from now, for the public search. The
   * same computation as bookableSlots(), a fortnight at a time from today until `limit` are
   * found or the booking horizon ends. Times only: nothing says why the others are taken.
   */
  async upcoming(workplaceId: string, options: UpcomingSlotsOptions): Promise<UpcomingSlot[]> {
    const now = options.now ?? new Date();
    if (options.limit < 1) return [];
    const workplace = await this.directory.workplace(workplaceId);
    if (!workplace || !isBookable(workplace)) return [];
    const horizon = await this.config.resolve('booking.booking_horizon_days');
    const last = tehranDayOf(new Date(now.getTime() + horizon.value * DAY_MS));
    const found: UpcomingSlot[] = [];
    for (let from = tehranDayOf(now); from <= last && found.length < options.limit;) {
      const windowEnd = addDays(from, UPCOMING_WINDOW_DAYS - 1);
      const to = windowEnd < last ? windowEnd : last;
      for (const slot of await this.freeSlots(workplace, from, to, now)) {
        if (options.serviceCode !== undefined && !slot.serviceCodes.includes(options.serviceCode)) {
          continue;
        }
        found.push({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          serviceCodes: slot.serviceCodes,
        });
        if (found.length === options.limit) break;
      }
      from = addDays(to, 1);
    }
    return found;
  }

  /** The free slots of these Tehran days (Gregorian YYYY-MM-DD, inclusive). */
  async freeSlots(
    workplace: WorkplaceRecord,
    from: string,
    to: string,
    now: Date,
    excludeAppointmentId?: string,
  ): Promise<Slot[]> {
    if (!isBookable(workplace)) return [];
    const [weekly, exceptions, calendar, horizon] = await Promise.all([
      this.calendars.liveRanges(this.db, workplace.id),
      this.db
        .select()
        .from(availabilityExceptions)
        .where(
          and(
            eq(availabilityExceptions.workplaceId, workplace.id),
            isNull(availabilityExceptions.deletedAt),
            between(availabilityExceptions.onDay, from, to),
          ),
        ),
      this.holidays.calendarFor({ from, to, cityCode: workplace.cityCode }),
      this.config.resolve('booking.booking_horizon_days'),
    ]);
    const notAfter = new Date(now.getTime() + horizon.value * DAY_MS);
    // A day runs from the Tehran midnight before `from` (UTC+03:30) to the one after `to`.
    const busy = await this.busy.busyFor(
      workplace.doctorId,
      new Date(Date.parse(from) - DAY_MS),
      new Date(Date.parse(to) + 2 * DAY_MS),
      { now, ...(excludeAppointmentId ? { excludeAppointmentId } : {}) },
    );
    return computeSlots({
      from,
      to,
      cityCode: workplace.cityCode,
      weekly,
      exceptions: exceptions.map((e) => ({ ...e, on: e.onDay })),
      holidays: calendar.calendar.holidays,
      busy,
      notBefore: now,
      notAfter,
    });
  }
}
