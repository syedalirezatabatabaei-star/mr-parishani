import { gregorianToJalali, jalaliToGregorian, type JalaliDate } from './calendar.js';

/**
 * Working days (task 2-1, doc 08 §5). Pure: the caller supplies the calendar (holidays and
 * weekly days off) that the config module loaded, so every module decides "is this a
 * working day" the same way. Days are Tehran calendar days, never UTC instants.
 */

export const WEEKDAYS = [
  'saturday',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface CalendarHoliday {
  /** The Tehran calendar day, YYYY-MM-DD (Gregorian), as stored. */
  readonly on: string;
  /** Null: national. A code (e.g. `tehran`): that city only. */
  readonly cityCode: string | null;
}

export interface WorkingCalendar {
  readonly weeklyDaysOff: readonly Weekday[];
  readonly holidays: readonly CalendarHoliday[];
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** The Gregorian YYYY-MM-DD of a Jalali day. */
export function gregorianDayOf(date: JalaliDate): string {
  const g = jalaliToGregorian(date);
  return `${pad(g.year, 4)}-${pad(g.month, 2)}-${pad(g.day, 2)}`;
}

/** Saturday … Friday: the Iranian week. */
export function weekdayOf(date: JalaliDate): Weekday {
  const g = jalaliToGregorian(date);
  // getUTCDay: 0 = Sunday … 6 = Saturday; shift so that Saturday = 0.
  const day = new Date(Date.UTC(g.year, g.month - 1, g.day)).getUTCDay();
  return WEEKDAYS[(day + 1) % 7] ?? 'saturday';
}

/** The next Jalali day. */
export function nextJalaliDay(date: JalaliDate): JalaliDate {
  const g = jalaliToGregorian(date);
  const next = new Date(Date.UTC(g.year, g.month - 1, g.day + 1));
  return gregorianToJalali({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  });
}

/**
 * Whether `date` is a working day for `cityCode`: not a weekly day off, not a national
 * holiday, and not a holiday of that city. `cityCode` null counts national holidays only
 * (installments, task 2-1 decision).
 */
export function isWorkingDay(
  date: JalaliDate,
  cityCode: string | null,
  calendar: WorkingCalendar,
): boolean {
  if (calendar.weeklyDaysOff.includes(weekdayOf(date))) return false;
  const day = gregorianDayOf(date);
  return !calendar.holidays.some(
    (h) => h.on === day && (h.cityCode === null || (cityCode !== null && h.cityCode === cityCode)),
  );
}

/** Bound on consecutive days off: a longer run means a broken calendar, not a holiday. */
export const MAX_CONSECUTIVE_DAYS_OFF = 30;

/** `date` itself if it is a working day, else the first working day after it. */
export function nextWorkingDay(
  date: JalaliDate,
  cityCode: string | null,
  calendar: WorkingCalendar,
): JalaliDate {
  if (calendar.weeklyDaysOff.length >= WEEKDAYS.length) {
    throw new RangeError('every weekday is a day off');
  }
  let day = date;
  for (let i = 0; i <= MAX_CONSECUTIVE_DAYS_OFF; i++) {
    if (isWorkingDay(day, cityCode, calendar)) return day;
    day = nextJalaliDay(day);
  }
  throw new RangeError(`no working day within ${String(MAX_CONSECUTIVE_DAYS_OFF)} days`);
}
