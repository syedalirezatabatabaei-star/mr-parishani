import { describe, expect, it } from 'vitest';
import { isJalaliLeapYear } from '../jalali/calendar.js';
import {
  holidayRulesSchema,
  holidaySuggestions,
  type HolidayRules,
} from './holiday-suggestions.js';

/** The country's fixed solar holidays (what 0088 seeds) and a few lunar ones. */
const rules: HolidayRules = holidayRulesSchema.parse({
  solar: [
    { month: 1, day: 1, title: 'نوروز' },
    { month: 1, day: 2, title: 'نوروز' },
    { month: 1, day: 3, title: 'نوروز' },
    { month: 1, day: 4, title: 'نوروز' },
    { month: 1, day: 12, title: 'روز جمهوری اسلامی' },
    { month: 1, day: 13, title: 'روز طبیعت' },
    { month: 3, day: 14, title: 'رحلت امام خمینی' },
    { month: 3, day: 15, title: 'قیام ۱۵ خرداد' },
    { month: 11, day: 22, title: 'پیروزی انقلاب اسلامی' },
    { month: 12, day: 29, title: 'ملی شدن صنعت نفت' },
  ],
  lunar: [
    { month: 1, day: 10, title: 'عاشورای حسینی' },
    { month: 2, day: 30, title: 'شهادت امام رضا' },
    { month: 10, day: 1, title: 'عید فطر' },
    { month: 12, day: 10, title: 'عید قربان' },
    { month: 12, day: 18, title: 'عید غدیر' },
  ],
});

const days = (from: string, to: string) => Math.abs(Date.parse(to) - Date.parse(from)) / 86_400_000;

describe('suggested official holidays (plan 3, ADR-043)', () => {
  it('solar days are exact: 1404 and 1405 as the official calendar has them', () => {
    const solar = (year: number) =>
      holidaySuggestions(year, { solar: rules.solar, lunar: [] }).map((d) => d.on);
    expect(solar(1404)).toEqual([
      '2025-03-21',
      '2025-03-22',
      '2025-03-23',
      '2025-03-24',
      '2025-04-01',
      '2025-04-02',
      '2025-06-04',
      '2025-06-05',
      '2026-02-11',
      '2026-03-20',
    ]);
    expect(solar(1405)).toEqual([
      '2026-03-21',
      '2026-03-22',
      '2026-03-23',
      '2026-03-24',
      '2026-04-01',
      '2026-04-02',
      '2026-06-04',
      '2026-06-05',
      '2027-02-11',
      '2027-03-20',
    ]);
    expect(
      holidaySuggestions(1405, { solar: rules.solar, lunar: [] }).every((d) => !d.estimated),
    ).toBe(true);
  });

  it('lunar days are estimates within one day of what Iran announced for 1404', () => {
    const lunar = holidaySuggestions(1404, { solar: [], lunar: rules.lunar });
    const of = (title: string) => lunar.filter((d) => d.title === title).map((d) => d.on);
    // The days of the official 1404 calendar.
    const announced: Record<string, string> = {
      'عید فطر': '2025-03-30',
      'عید قربان': '2025-06-06',
      'عید غدیر': '2025-06-14',
      'عاشورای حسینی': '2025-07-06',
    };
    for (const [title, on] of Object.entries(announced)) {
      const found = of(title);
      expect(found.length, title).toBeGreaterThan(0);
      expect(Math.min(...found.map((d) => days(d, on))), title).toBeLessThanOrEqual(1);
    }
    expect(lunar.every((d) => d.estimated)).toBe(true);
    // Every suggestion lies inside the Jalali year.
    expect(lunar.every((d) => d.on >= '2025-03-21' && d.on <= '2026-03-20')).toBe(true);
  });

  it('a lunar day 30 is the last day of a 29-day month; a Jalali year may hold a lunar day twice', () => {
    const end = holidaySuggestions(1404, {
      solar: [],
      lunar: [{ month: 2, day: 30, title: 'آخر صفر' }],
    });
    expect(end).toHaveLength(1);
    // 354 days to a Hijri year: some day of it comes twice in 365.
    const twice = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].some(
      (month) =>
        holidaySuggestions(1405, { solar: [], lunar: [{ month, day: 5, title: 'آزمون' }] })
          .length === 2,
    );
    expect(twice).toBe(true);
  });

  it('30 Esfand only in a leap year', () => {
    const leap = [1403, 1404, 1405, 1406, 1407, 1408].find(isJalaliLeapYear) ?? 0;
    const plain = [1403, 1404, 1405, 1406, 1407, 1408].find((y) => !isJalaliLeapYear(y)) ?? 0;
    const esfand30 = { solar: [{ month: 12, day: 30, title: 'آزمون کبیسه' }], lunar: [] };
    expect(holidaySuggestions(leap, esfand30)).toHaveLength(1);
    expect(holidaySuggestions(plain, esfand30)).toHaveLength(0);
  });

  it('two rules on one day are one suggestion, estimated if either is lunar', () => {
    // The lunar rule of whatever Hijri day 1 Farvardin 1405 is.
    const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
      timeZone: 'UTC',
      month: 'numeric',
      day: 'numeric',
    });
    const parts = fmt.formatToParts(new Date('2026-03-21T12:00:00Z'));
    const month = Number(parts.find((p) => p.type === 'month')?.value);
    const day = Number(parts.find((p) => p.type === 'day')?.value);
    const merged = holidaySuggestions(1405, {
      solar: [{ month: 1, day: 1, title: 'نوروز' }],
      lunar: [{ month, day, title: 'روز قمری' }],
    }).filter((d) => d.on === '2026-03-21');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: 'نوروز، روز قمری', estimated: true });
  });

  it('rules: a real day of the month, no day twice', () => {
    const ok = { solar: [], lunar: [] };
    expect(holidayRulesSchema.safeParse(ok).success).toBe(true);
    const solar = (month: number, day: number) =>
      holidayRulesSchema.safeParse({ solar: [{ month, day, title: 'آزمون' }], lunar: [] }).success;
    expect(solar(6, 31)).toBe(true);
    expect(solar(7, 31)).toBe(false);
    expect(solar(12, 30)).toBe(true);
    expect(solar(13, 1)).toBe(false);
    expect(
      holidayRulesSchema.safeParse({ solar: [], lunar: [{ month: 1, day: 31, title: 'آزمون' }] })
        .success,
    ).toBe(false);
    expect(
      holidayRulesSchema.safeParse({
        solar: [
          { month: 1, day: 1, title: 'نوروز' },
          { month: 1, day: 1, title: 'تکرار' },
        ],
        lunar: [],
      }).success,
    ).toBe(false);
  });
});
