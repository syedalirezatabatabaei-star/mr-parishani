/**
 * Calendar arithmetic on civil (time-zone-free) dates. This is the only file allowed to
 * import jalaali-js; everything else uses the functions exported here (lint rule
 * `sepehr/jalali-via-wrapper`).
 *
 * jalaali-js implements Borkowski's algorithm. Its docs claim exact agreement with Intl's
 * `persian` calendar for Gregorian 1800–2256, but against ICU 78 (Node 24) the two differ
 * on the leap years 1176, 1502 and 1601, and agree on every day from 1178 to 1501. Which
 * one is right about 1502 has not been established, so the supported range stops before
 * it: outside it every function throws instead of returning an unverified date.
 * `intl-cross-check.test.ts` checks every day of the range against Intl.
 */
import { isLeapJalaaliYear, jalaaliMonthLength, toGregorian, toJalaali } from 'jalaali-js';

/** 1200 = Gregorian 1821. */
export const JALALI_MIN_YEAR = 1200;
/** 1500 = Gregorian 2121. The next year both implementations disagree on is 1502. */
export const JALALI_MAX_YEAR = 1500;

/** A day in the Jalali calendar. Months are 1-based: 1 = Farvardin, 12 = Esfand. */
export interface JalaliDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A day in the Gregorian calendar. Months are 1-based. */
export interface GregorianDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < JALALI_MIN_YEAR || year > JALALI_MAX_YEAR) {
    throw new RangeError(
      `Jalali year ${String(year)} is outside the supported range ${String(JALALI_MIN_YEAR)}–${String(JALALI_MAX_YEAR)}`,
    );
  }
}

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Jalali month must be an integer 1–12, got ${String(month)}`);
  }
}

function assertValid(date: JalaliDate): void {
  if (!isValidJalaliDate(date)) {
    throw new RangeError(
      `Invalid Jalali date ${String(date.year)}/${String(date.month)}/${String(date.day)}`,
    );
  }
}

/** True for a 366-day year, in which Esfand has 30 days. */
export function isJalaliLeapYear(year: number): boolean {
  assertYear(year);
  return isLeapJalaaliYear(year);
}

/** 31 for months 1–6, 30 for months 7–11, and 29 or 30 for Esfand. */
export function jalaliMonthLength(year: number, month: number): number {
  assertYear(year);
  assertMonth(month);
  return jalaaliMonthLength(year, month);
}

/** Strict check: integer parts, supported year, real month and day. */
export function isValidJalaliDate(date: JalaliDate): boolean {
  const { year, month, day } = date;
  return (
    Number.isInteger(year) &&
    year >= JALALI_MIN_YEAR &&
    year <= JALALI_MAX_YEAR &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= jalaaliMonthLength(year, month)
  );
}

export function jalaliToGregorian(date: JalaliDate): GregorianDate {
  assertValid(date);
  const { gy, gm, gd } = toGregorian(date.year, date.month, date.day);
  return { year: gy, month: gm, day: gd };
}

export function gregorianToJalali(date: GregorianDate): JalaliDate {
  const { year, month, day } = date;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid Gregorian date ${String(year)}-${String(month)}-${String(day)}`);
  }
  const { jy, jm, jd } = toJalaali(year, month, day);
  assertYear(jy);
  return { year: jy, month: jm, day: jd };
}

/**
 * Adds whole months, keeping the day of month and clamping it to the last day of the
 * target month (doc 02, due-date rule): 31 Farvardin + 6 → 30 Mehr, and 30 Mehr + 5 → 29
 * Esfand in a common year or 30 Esfand in a leap year.
 *
 * Always count from the original date; chaining calls would lose a clamped day
 * (31 Shahrivar + 1 + 6 is 30 Farvardin, while 31 Shahrivar + 7 is 31 Farvardin).
 */
export function addJalaliMonths(date: JalaliDate, months: number): JalaliDate {
  assertValid(date);
  if (!Number.isInteger(months)) {
    throw new RangeError(`Months to add must be an integer, got ${String(months)}`);
  }
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  assertYear(year);
  return { year, month, day: Math.min(date.day, jalaaliMonthLength(year, month)) };
}

/** Negative if a is before b, positive if after, 0 if the same day. */
export function compareJalali(a: JalaliDate, b: JalaliDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}
