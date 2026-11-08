import { describe, expect, it } from 'vitest';
import { formatJalaliDate, formatJalaliDateTime, parseJalaliDate } from './format.js';

describe('formatJalaliDate', () => {
  const date = { year: 1405, month: 6, day: 8 };

  it('defaults to numeric with Persian digits', () => {
    expect(formatJalaliDate(date)).toBe('۱۴۰۵/۰۶/۰۸');
  });

  it('can use ASCII digits', () => {
    expect(formatJalaliDate(date, { digits: 'latn' })).toBe('1405/06/08');
  });

  it('has a long style with the month name', () => {
    expect(formatJalaliDate(date, { style: 'long' })).toBe('۸ شهریور ۱۴۰۵');
    expect(formatJalaliDate({ year: 1404, month: 12, day: 29 }, { style: 'long' })).toBe(
      '۲۹ اسفند ۱۴۰۴',
    );
  });

  it('rejects an invalid date', () => {
    expect(() => formatJalaliDate({ year: 1404, month: 12, day: 30 })).toThrow(RangeError);
  });
});

describe('formatJalaliDateTime', () => {
  it('shows Tehran date and time of a UTC instant', () => {
    expect(formatJalaliDateTime(new Date('2026-09-19T11:00:00Z'))).toBe('۱۴۰۵/۰۶/۲۸ ۱۴:۳۰');
    expect(formatJalaliDateTime(new Date('2026-09-18T20:30:00Z'), { digits: 'latn' })).toBe(
      '1405/06/28 00:00',
    );
  });
});

describe('parseJalaliDate', () => {
  it.each([
    '1405/06/28',
    '1405/6/28',
    '1405-06-28',
    '1405.06.28',
    '۱۴۰۵/۰۶/۲۸',
    '١٤٠٥/٠٦/٢٨',
    '  1405/06/28  ',
  ])('parses %j', (input) => {
    expect(parseJalaliDate(input)).toEqual({ year: 1405, month: 6, day: 28 });
  });

  it.each([
    '1404/12/30', // 1404 is not leap
    '1405/07/31', // Mehr has 30 days
    '1405/13/01',
    '1405/00/10',
    '05/06/28',
    '1405/06',
    '1405/06/28 10:00',
    'abc',
    '',
  ])('rejects %j', (input) => {
    expect(parseJalaliDate(input)).toBeNull();
  });

  it('accepts 30 Esfand only in a leap year', () => {
    expect(parseJalaliDate('1403/12/30')).toEqual({ year: 1403, month: 12, day: 30 });
    expect(parseJalaliDate('1404/12/29')).toEqual({ year: 1404, month: 12, day: 29 });
  });
});
