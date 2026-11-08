import { describe, expect, it } from 'vitest';
import {
  JALALI_MAX_YEAR,
  JALALI_MIN_YEAR,
  addJalaliMonths,
  compareJalali,
  gregorianToJalali,
  isJalaliLeapYear,
  isValidJalaliDate,
  jalaliMonthLength,
  jalaliToGregorian,
  type JalaliDate,
} from './calendar.js';

const j = (year: number, month: number, day: number): JalaliDate => ({ year, month, day });

describe('leap years', () => {
  // Official leap years 1370–1420. Note the five-year gap 1403 → 1408, where a plain
  // 33-year cycle goes wrong.
  const LEAP = [1370, 1375, 1379, 1383, 1387, 1391, 1395, 1399, 1403, 1408, 1412, 1416, 1420];

  it('matches the official list for 1370–1420', () => {
    const found: number[] = [];
    for (let year = 1370; year <= 1420; year++) if (isJalaliLeapYear(year)) found.push(year);
    expect(found).toEqual(LEAP);
  });

  it.each([1399, 1403, 1408])('%i is leap', (year) => {
    expect(isJalaliLeapYear(year)).toBe(true);
  });

  it.each([1400, 1402, 1404, 1405, 1406, 1407])('%i is not leap', (year) => {
    expect(isJalaliLeapYear(year)).toBe(false);
  });
});

describe('Esfand', () => {
  it('has 29 days in a common year and 30 in a leap year', () => {
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliMonthLength(1405, 12)).toBe(29);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1408, 12)).toBe(30);
  });

  it('30 Esfand exists only in leap years', () => {
    expect(isValidJalaliDate(j(1403, 12, 30))).toBe(true);
    expect(isValidJalaliDate(j(1404, 12, 30))).toBe(false);
    expect(isValidJalaliDate(j(1405, 12, 30))).toBe(false);
    expect(() => jalaliToGregorian(j(1404, 12, 30))).toThrow(RangeError);
  });

  it('the day after the last day of Esfand is 1 Farvardin', () => {
    // Common year: 29 Esfand 1404 = 20 March 2026, 1 Farvardin 1405 = 21 March 2026.
    expect(jalaliToGregorian(j(1404, 12, 29))).toEqual({ year: 2026, month: 3, day: 20 });
    expect(jalaliToGregorian(j(1405, 1, 1))).toEqual({ year: 2026, month: 3, day: 21 });
    // Leap year: 30 Esfand 1403 = 20 March 2025, 1 Farvardin 1404 = 21 March 2025.
    expect(jalaliToGregorian(j(1403, 12, 30))).toEqual({ year: 2025, month: 3, day: 20 });
    expect(jalaliToGregorian(j(1404, 1, 1))).toEqual({ year: 2025, month: 3, day: 21 });
  });
});

describe('month lengths', () => {
  it('are 31 for months 1–6 and 30 for months 7–11', () => {
    for (let month = 1; month <= 11; month++) {
      expect(jalaliMonthLength(1405, month)).toBe(month <= 6 ? 31 : 30);
    }
  });

  it('give 365 days in a common year and 366 in a leap year', () => {
    const days = (year: number) =>
      Array.from({ length: 12 }, (_, i) => jalaliMonthLength(year, i + 1)).reduce((a, b) => a + b);
    expect(days(1404)).toBe(365);
    expect(days(1403)).toBe(366);
  });
});

describe('conversion', () => {
  it.each([
    [j(1405, 6, 28), { year: 2026, month: 9, day: 19 }],
    [j(1399, 12, 30), { year: 2021, month: 3, day: 20 }],
    [j(1400, 1, 1), { year: 2021, month: 3, day: 21 }],
    [j(1395, 1, 23), { year: 2016, month: 4, day: 11 }],
    [j(1357, 11, 22), { year: 1979, month: 2, day: 11 }],
  ])('%o ↔ %o', (jalali, gregorian) => {
    expect(jalaliToGregorian(jalali)).toEqual(gregorian);
    expect(gregorianToJalali(gregorian)).toEqual(jalali);
  });

  it('round-trips every day from 1300 to 1500, one Gregorian day apart', () => {
    let previous: number | null = null;
    for (let year = 1300; year <= 1500; year++) {
      for (let month = 1; month <= 12; month++) {
        const length = jalaliMonthLength(year, month);
        for (let day = 1; day <= length; day++) {
          const g = jalaliToGregorian(j(year, month, day));
          const utc = Date.UTC(g.year, g.month - 1, g.day);
          if (previous !== null && utc - previous !== 86_400_000) {
            throw new Error(`gap before ${String(year)}/${String(month)}/${String(day)}`);
          }
          previous = utc;
          const back = gregorianToJalali(g);
          if (back.year !== year || back.month !== month || back.day !== day) {
            throw new Error(`round trip failed at ${String(year)}/${String(month)}/${String(day)}`);
          }
        }
      }
    }
  });

  it('rejects invalid Gregorian dates', () => {
    expect(() => gregorianToJalali({ year: 2025, month: 2, day: 29 })).toThrow(RangeError);
    expect(() => gregorianToJalali({ year: 2026, month: 13, day: 1 })).toThrow(RangeError);
    expect(() => gregorianToJalali({ year: 2026, month: 1, day: 1.5 })).toThrow(RangeError);
  });
});

describe('isValidJalaliDate', () => {
  it.each([
    [j(1405, 6, 31), true],
    [j(1405, 7, 30), true],
    [j(1405, 7, 31), false],
    [j(1405, 13, 1), false],
    [j(1405, 0, 1), false],
    [j(1405, 1, 0), false],
    [j(1405, 1, 1.5), false],
    [j(Number.NaN, 1, 1), false],
    [j(JALALI_MIN_YEAR, 1, 1), true],
    [j(JALALI_MAX_YEAR, 12, 29), true],
    [j(JALALI_MIN_YEAR - 1, 1, 1), false],
    [j(JALALI_MAX_YEAR + 1, 1, 1), false],
  ])('%o → %s', (date, valid) => {
    expect(isValidJalaliDate(date)).toBe(valid);
  });

  it('throws outside the supported range instead of guessing', () => {
    expect(() => isJalaliLeapYear(JALALI_MAX_YEAR + 1)).toThrow(RangeError);
    expect(() => jalaliMonthLength(1405, 13)).toThrow(RangeError);
  });
});

describe('addJalaliMonths (doc 02 due-date rule)', () => {
  it('follows the examples in doc 02', () => {
    // 31 Farvardin → 31 Ordibehesht (31 days) → 30 Mehr (30 days).
    expect(addJalaliMonths(j(1405, 1, 31), 1)).toEqual(j(1405, 2, 31));
    expect(addJalaliMonths(j(1405, 1, 31), 6)).toEqual(j(1405, 7, 30));
    // 30 Mehr → 29 Esfand in a common year, 30 Esfand in a leap year.
    expect(addJalaliMonths(j(1404, 7, 30), 5)).toEqual(j(1404, 12, 29));
    expect(addJalaliMonths(j(1403, 7, 30), 5)).toEqual(j(1403, 12, 30));
  });

  it('keeps the original day instead of the clamped one', () => {
    const start = j(1405, 6, 31);
    expect(addJalaliMonths(start, 1)).toEqual(j(1405, 7, 30));
    expect(addJalaliMonths(start, 7)).toEqual(j(1406, 1, 31));
  });

  it('crosses years in both directions', () => {
    expect(addJalaliMonths(j(1405, 11, 15), 3)).toEqual(j(1406, 2, 15));
    expect(addJalaliMonths(j(1405, 2, 15), -3)).toEqual(j(1404, 11, 15));
    expect(addJalaliMonths(j(1405, 5, 10), 0)).toEqual(j(1405, 5, 10));
    expect(addJalaliMonths(j(1405, 1, 1), 36)).toEqual(j(1408, 1, 1));
  });

  it('clamps 30 Esfand of a leap year to 29 Esfand of a common one', () => {
    expect(addJalaliMonths(j(1403, 12, 30), 12)).toEqual(j(1404, 12, 29));
    expect(addJalaliMonths(j(1403, 12, 30), 60)).toEqual(j(1408, 12, 30));
  });

  it('rejects fractional months and invalid dates', () => {
    expect(() => addJalaliMonths(j(1405, 1, 1), 1.5)).toThrow(RangeError);
    expect(() => addJalaliMonths(j(1404, 12, 30), 1)).toThrow(RangeError);
  });
});

describe('compareJalali', () => {
  it('orders by year, month, then day', () => {
    expect(compareJalali(j(1405, 1, 1), j(1404, 12, 29))).toBeGreaterThan(0);
    expect(compareJalali(j(1405, 6, 28), j(1405, 7, 1))).toBeLessThan(0);
    expect(compareJalali(j(1405, 6, 28), j(1405, 6, 28))).toBe(0);
  });
});
