import { describe, expect, it } from 'vitest';
import {
  addJalaliDays,
  jalaliDaysBetween,
  parseJalaliRange,
  startOfJalaliWeek,
} from './calendars.js';
import { weekdayOf } from './working-days.js';

describe('Jalali day arithmetic for the calendar (task 2-10)', () => {
  it('adds days across months and years, and counts them', () => {
    expect(addJalaliDays({ year: 1402, month: 12, day: 29 }, 1)).toEqual({
      year: 1403,
      month: 1,
      day: 1,
    });
    expect(addJalaliDays({ year: 1403, month: 1, day: 1 }, -1)).toEqual({
      year: 1402,
      month: 12,
      day: 29,
    });
    expect(
      jalaliDaysBetween({ year: 1405, month: 1, day: 1 }, { year: 1406, month: 1, day: 1 }),
    ).toBe(365);
  });

  it('starts every week on Saturday', () => {
    const start = startOfJalaliWeek({ year: 1405, month: 7, day: 8 });
    expect(weekdayOf(start)).toBe('saturday');
    expect(jalaliDaysBetween(start, { year: 1405, month: 7, day: 8 })).toBeLessThan(7);
  });

  it('reads a typed range in any digit script and either order', () => {
    const range = { from: { year: 1405, month: 7, day: 1 }, to: { year: 1405, month: 7, day: 10 } };
    expect(parseJalaliRange('۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۱۰')).toEqual(range);
    expect(parseJalaliRange('1405-07-10 – 1405/7/1')).toEqual(range);
    // As a page shows it: each date isolated left to right (LRI … PDI), or with marks.
    expect(parseJalaliRange('\u2066۱۴۰۵/۰۷/۰۱\u2069 تا \u2066۱۴۰۵/۰۷/۱۰\u2069')).toEqual(range);
    expect(parseJalaliRange('\u200e1405/07/01\u200e تا \u200f1405/07/10')).toEqual(range);
    expect(parseJalaliRange('١٤٠٥/٠٧/٠١ to ١٤٠٥/٠٧/١٠')).toEqual(range);
    expect(parseJalaliRange('۱۴۰۵/۰۷/۰۱')).toBeNull();
    expect(parseJalaliRange('۱۴۰۵/۱۳/۰۱ تا ۱۴۰۵/۰۷/۱۰')).toBeNull();
  });
});
