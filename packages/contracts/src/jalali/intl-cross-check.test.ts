/**
 * Independent check of the wrapper (jalaali-js) against Intl's Persian calendar (ICU), for
 * every day of the supported range. The two implementations agree across it; any
 * difference must be investigated before trusting either.
 */
import { describe, expect, it } from 'vitest';
import {
  JALALI_MAX_YEAR,
  JALALI_MIN_YEAR,
  isJalaliLeapYear,
  jalaliMonthLength,
  jalaliToGregorian,
} from './calendar.js';

const persian = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

function intlJalali(utcMs: number): string {
  const parts = Object.fromEntries(
    persian.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  return `${parts['year'] ?? '?'}/${parts['month'] ?? '?'}/${parts['day'] ?? '?'}`;
}

describe('Intl cross-check', () => {
  it(`agrees with Intl on every day of ${String(JALALI_MIN_YEAR)}–${String(JALALI_MAX_YEAR)}`, () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (let year = JALALI_MIN_YEAR; year <= JALALI_MAX_YEAR; year++) {
      for (let month = 1; month <= 12; month++) {
        const length = jalaliMonthLength(year, month);
        for (let day = 1; day <= length; day++) {
          const g = jalaliToGregorian({ year, month, day });
          const ours = `${String(year)}/${String(month)}/${String(day)}`;
          const theirs = intlJalali(Date.UTC(g.year, g.month - 1, g.day));
          if (ours !== theirs && mismatches.length < 20) mismatches.push(`${ours} ≠ ${theirs}`);
          checked++;
        }
      }
    }
    expect(mismatches).toEqual([]);
    // 301 years × ~365.24 days.
    expect(checked).toBeGreaterThan(109_000);
  });

  it('agrees with Intl on every leap year', () => {
    for (let year = JALALI_MIN_YEAR; year <= JALALI_MAX_YEAR; year++) {
      const g = jalaliToGregorian({ year, month: 12, day: 29 });
      const nextDay = intlJalali(Date.UTC(g.year, g.month - 1, g.day + 1));
      expect(nextDay === `${String(year)}/12/30`, `year ${String(year)}`).toBe(
        isJalaliLeapYear(year),
      );
    }
  });
});
