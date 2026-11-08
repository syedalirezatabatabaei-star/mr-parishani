/**
 * What the one calendar component (task 2-10, doc 08 §13) needs besides the Jalali
 * conversion: day arithmetic, weeks from Saturday, and a typed range. Only Jalali dates are
 * ever shown (ADR-011): nothing here names a Gregorian or Hijri day. Part of the wrapper: the UI never converts dates
 * itself (lint rule jalali-via-wrapper).
 */
import { normalizeDigits } from '../text/digits.js';
import { gregorianToJalali, jalaliToGregorian, type JalaliDate } from './calendar.js';
import { parseJalaliDate, stripBidiMarks } from './format.js';
import { weekdayOf, WEEKDAYS } from './working-days.js';

/** A Jalali day plus `days` (negative goes back). */
export function addJalaliDays(date: JalaliDate, days: number): JalaliDate {
  const g = jalaliToGregorian(date);
  const d = new Date(Date.UTC(g.year, g.month - 1, g.day + days));
  return gregorianToJalali({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
}

/** The Saturday that starts the Iranian week this day belongs to. */
export function startOfJalaliWeek(date: JalaliDate): JalaliDate {
  return addJalaliDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function jalaliDaysBetween(a: JalaliDate, b: JalaliDate): number {
  const ga = jalaliToGregorian(a);
  const gb = jalaliToGregorian(b);
  return Math.round(
    (Date.UTC(gb.year, gb.month - 1, gb.day) - Date.UTC(ga.year, ga.month - 1, ga.day)) /
      86_400_000,
  );
}

/**
 * A range typed by a user: two dates joined by «تا», «to», an en or em dash, or «~», in any
 * digit script; the earlier first whatever the order typed. Null unless both are real dates.
 */
export function parseJalaliRange(input: string): { from: JalaliDate; to: JalaliDate } | null {
  const parts = stripBidiMarks(normalizeDigits(input))
    .split(/\s*(?:تا|to|–|—|~)\s*/i)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length !== 2) return null;
  const a = parseJalaliDate(parts[0] ?? '');
  const b = parseJalaliDate(parts[1] ?? '');
  if (!a || !b) return null;
  return jalaliDaysBetween(a, b) >= 0 ? { from: a, to: b } : { from: b, to: a };
}
