/**
 * Instants are stored in UTC; dates are shown and entered in Jalali, Tehran time (rule 21).
 * The UTC offset comes from the time-zone database through Intl, so past daylight-saving
 * time (abolished in 2022) is handled for historical instants.
 */
import { gregorianToJalali, jalaliToGregorian, type JalaliDate } from './calendar.js';

export const TEHRAN_TIME_ZONE = 'Asia/Tehran';

/** A Jalali day with a wall-clock time in Tehran. */
export interface JalaliDateTime extends JalaliDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** A wall-clock time. Omitted parts are 0. */
export interface WallTime {
  readonly hour: number;
  readonly minute?: number;
  readonly second?: number;
}

const DAY_MS = 86_400_000;

// Gregorian parts in Tehran; the Jalali conversion is done by the wrapper, never by Intl.
const tehranParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TEHRAN_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function assertInstant(instant: Date): void {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid Date');
}

function tehranWallClock(epochMs: number): WallClock {
  const clock: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of tehranParts.formatToParts(new Date(epochMs))) {
    if (part.type in clock) clock[part.type as keyof WallClock] = Number(part.value);
  }
  return clock;
}

/** Wall clock read as if it were UTC, in whole seconds. */
function wallClockMs(c: WallClock): number {
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
}

/** Tehran's UTC offset at an instant, in milliseconds. */
function offsetAt(epochMs: number): number {
  const wholeSecond = Math.floor(epochMs / 1000) * 1000;
  return wallClockMs(tehranWallClock(wholeSecond)) - wholeSecond;
}

/** The Jalali day in Tehran at the given instant. */
export function toJalali(instant: Date): JalaliDate {
  const { year, month, day } = toJalaliDateTime(instant);
  return { year, month, day };
}

/** The Jalali day and wall-clock time in Tehran at the given instant. */
export function toJalaliDateTime(instant: Date): JalaliDateTime {
  assertInstant(instant);
  const clock = tehranWallClock(instant.getTime());
  return {
    ...gregorianToJalali({ year: clock.year, month: clock.month, day: clock.day }),
    hour: clock.hour,
    minute: clock.minute,
    second: clock.second,
  };
}

/**
 * The instant at which Tehran's clock showed the given Jalali day and time (default
 * 00:00). When daylight-saving time was in force, a skipped wall time resolves to the
 * instant one hour later, and a repeated one to its first occurrence.
 */
export function fromJalali(date: JalaliDate, time: WallTime = { hour: 0 }): Date {
  const { hour, minute = 0, second = 0 } = time;
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new RangeError(`Invalid time ${String(hour)}:${String(minute)}:${String(second)}`);
  }
  const g = jalaliToGregorian(date);
  const local = Date.UTC(g.year, g.month - 1, g.day, hour, minute, second);

  const before = offsetAt(local - DAY_MS);
  const after = offsetAt(local + DAY_MS);
  const matches = [...new Set([before, after])]
    .map((offset) => local - offset)
    .filter((candidate) => wallClockMs(tehranWallClock(candidate)) === local);

  // No match: the wall time was skipped. The pre-transition offset lands one hour later.
  return new Date(matches.length > 0 ? Math.min(...matches) : local - before);
}
