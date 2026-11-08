import { gregorianToJalali, type JalaliDate } from '../jalali/calendar.js';
import { fromJalali } from '../jalali/tehran.js';
import {
  gregorianDayOf,
  isWorkingDay,
  nextJalaliDay,
  weekdayOf,
  type CalendarHoliday,
  type Weekday,
} from '../jalali/working-days.js';
import type { AvailabilityExceptionKind } from './schedule.js';

/**
 * Slot computation (task 2-5, doc 08 §6). Slots are never stored: they are derived from the
 * weekly schedule, the exceptions, the holidays and the time already taken, so changing a
 * schedule is one write and the tables stay small. Pure, like the working-day rules: the
 * caller loads the data, and every day is a Tehran calendar day, never a UTC one (doc 08
 * §15 test 13).
 *
 * The rules of a day:
 * - The weekly schedule applies unless the day is a holiday, national or of the
 *   workplace's city, that the doctor has not opened (`open_holiday`; test 3). The system's
 *   weekly days off do not apply: the doctor's schedule decides (task 2-5 decision).
 * - `closed` takes the whole day or a range of it out of the weekly schedule.
 * - `extra` adds hours even on a holiday or a closed day; where it meets the weekly
 *   schedule, the schedule wins.
 * - Nothing starts before `notBefore` or at or after `notAfter`, and nothing overlaps a
 *   busy interval.
 */

/** One range of the weekly schedule. Minutes since Tehran midnight, end up to 1440. */
export interface WeeklyRange {
  readonly weekday: Weekday;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly slotMinutes: number;
  readonly serviceCodes: readonly string[];
}

/** An exception on one Tehran day (`on`: YYYY-MM-DD, Gregorian, as stored). */
export interface DayException {
  readonly on: string;
  readonly kind: AvailabilityExceptionKind;
  /** Null for a whole-day closure and for `open_holiday`. */
  readonly startMinute: number | null;
  readonly endMinute: number | null;
  /** `extra` only. */
  readonly slotMinutes: number | null;
  readonly serviceCodes: readonly string[];
}

/** Time already taken (appointments, task 2-6), at this workplace or elsewhere. */
export interface BusyInterval {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface SlotInput {
  /** Gregorian days (the Tehran day), YYYY-MM-DD, inclusive. */
  readonly from: string;
  readonly to: string;
  /** The workplace's city: its holidays close the schedule as national ones do. */
  readonly cityCode: string;
  readonly weekly: readonly WeeklyRange[];
  readonly exceptions: readonly DayException[];
  readonly holidays: readonly CalendarHoliday[];
  readonly busy: readonly BusyInterval[];
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export interface Slot {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly serviceCodes: readonly string[];
}

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

interface DaySlot {
  readonly start: number;
  readonly end: number;
  readonly serviceCodes: readonly string[];
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd && bStart < aEnd;

function parseDay(day: string): JalaliDate {
  const [year, month, date] = day.split('-').map(Number);
  return gregorianToJalali({ year: year ?? 0, month: month ?? 0, day: date ?? 0 });
}

function cut(start: number, end: number, size: number, serviceCodes: readonly string[]) {
  const slots: DaySlot[] = [];
  for (let m = start; m + size <= end; m += size) {
    slots.push({ start: m, end: m + size, serviceCodes });
  }
  return slots;
}

/** The slots of one Tehran day, in minutes. */
function daySlots(
  weekly: readonly WeeklyRange[],
  exceptions: readonly DayException[],
  holiday: boolean,
): DaySlot[] {
  const opened = exceptions.some((e) => e.kind === 'open_holiday');
  const closed = exceptions.filter((e) => e.kind === 'closed');
  const closedAllDay = closed.some((e) => e.startMinute === null);

  const scheduled: DaySlot[] = [];
  if ((!holiday || opened) && !closedAllDay) {
    for (const range of weekly) {
      for (const slot of cut(
        range.startMinute,
        range.endMinute,
        range.slotMinutes,
        range.serviceCodes,
      )) {
        const isClosed = closed.some((c) =>
          overlaps(slot.start, slot.end, c.startMinute ?? 0, c.endMinute ?? DAY_MINUTES),
        );
        if (!isClosed) scheduled.push(slot);
      }
    }
  }
  const extra: DaySlot[] = [];
  for (const e of exceptions) {
    if (e.kind !== 'extra' || e.startMinute === null || e.endMinute === null) continue;
    for (const slot of cut(
      e.startMinute,
      e.endMinute,
      e.slotMinutes ?? DAY_MINUTES,
      e.serviceCodes,
    )) {
      if (!scheduled.some((s) => overlaps(slot.start, slot.end, s.start, s.end))) extra.push(slot);
    }
  }
  return [...scheduled, ...extra];
}

export function computeSlots(input: SlotInput): Slot[] {
  const byWeekday = new Map<Weekday, WeeklyRange[]>();
  for (const range of input.weekly) {
    byWeekday.set(range.weekday, [...(byWeekday.get(range.weekday) ?? []), range]);
  }
  const byDay = new Map<string, DayException[]>();
  for (const e of input.exceptions) byDay.set(e.on, [...(byDay.get(e.on) ?? []), e]);
  // Holidays only: the weekly days off of the system do not close a doctor's schedule.
  const holidays = { weeklyDaysOff: [], holidays: input.holidays };
  const notBefore = input.notBefore.getTime();
  const notAfter = input.notAfter.getTime();

  const slots: Slot[] = [];
  const last = parseDay(input.to);
  let date = parseDay(input.from);
  let dayStart = fromJalali(date).getTime();
  for (let guard = 0; guard <= 400; guard++) {
    const next = nextJalaliDay(date);
    const nextStart = fromJalali(next).getTime();
    if (nextStart > notBefore && dayStart < notAfter) {
      const day = gregorianDayOf(date);
      const holiday = !isWorkingDay(date, input.cityCode, holidays);
      // A day of 24 hours (every day since Iran dropped daylight saving time in 2022) maps
      // minutes to instants directly; any other day asks the time-zone database per slot.
      const regular = nextStart - dayStart === DAY_MINUTES * MINUTE_MS;
      const at = (minute: number) =>
        regular || minute === 0
          ? dayStart + minute * MINUTE_MS
          : minute === DAY_MINUTES
            ? nextStart
            : fromJalali(date, { hour: Math.floor(minute / 60), minute: minute % 60 }).getTime();
      for (const slot of daySlots(
        byWeekday.get(weekdayOf(date)) ?? [],
        byDay.get(day) ?? [],
        holiday,
      )) {
        const startsAt = at(slot.start);
        const endsAt = at(slot.end);
        if (startsAt < notBefore || startsAt >= notAfter) continue;
        const busy = input.busy.some(
          (b) => startsAt < b.endsAt.getTime() && b.startsAt.getTime() < endsAt,
        );
        if (!busy) {
          slots.push({
            startsAt: new Date(startsAt),
            endsAt: new Date(endsAt),
            serviceCodes: slot.serviceCodes,
          });
        }
      }
    }
    if (date.year === last.year && date.month === last.month && date.day === last.day) break;
    date = next;
    dayStart = nextStart;
  }
  return slots.sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() || a.endsAt.getTime() - b.endsAt.getTime(),
  );
}
