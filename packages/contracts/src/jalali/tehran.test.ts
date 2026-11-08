import { describe, expect, it } from 'vitest';
import { jalaliMonthLength } from './calendar.js';
import { fromJalali, toJalali, toJalaliDateTime } from './tehran.js';

const utc = (iso: string) => new Date(iso);

describe('toJalali (Tehran day of a UTC instant)', () => {
  it('changes day at Tehran midnight, not UTC midnight', () => {
    // Tehran is UTC+03:30 since 2022.
    expect(toJalali(utc('2026-09-18T20:29:59Z'))).toEqual({ year: 1405, month: 6, day: 27 });
    expect(toJalali(utc('2026-09-18T20:30:00Z'))).toEqual({ year: 1405, month: 6, day: 28 });
  });

  it('crosses Nowruz at Tehran midnight', () => {
    expect(toJalali(utc('2026-03-20T20:29:59Z'))).toEqual({ year: 1404, month: 12, day: 29 });
    expect(toJalali(utc('2026-03-20T20:30:00Z'))).toEqual({ year: 1405, month: 1, day: 1 });
  });

  it('uses the +04:30 daylight-saving offset of past summers', () => {
    expect(toJalaliDateTime(utc('2021-06-01T12:00:00Z'))).toEqual({
      year: 1400,
      month: 3,
      day: 11,
      hour: 16,
      minute: 30,
      second: 0,
    });
  });

  it('rejects an invalid Date', () => {
    expect(() => toJalali(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('fromJalali (Tehran wall time to a UTC instant)', () => {
  it('defaults to 00:00 Tehran time', () => {
    expect(fromJalali({ year: 1405, month: 6, day: 28 }).toISOString()).toBe(
      '2026-09-18T20:30:00.000Z',
    );
  });

  it('takes a wall-clock time', () => {
    expect(
      fromJalali({ year: 1405, month: 6, day: 28 }, { hour: 14, minute: 30 }).toISOString(),
    ).toBe('2026-09-19T11:00:00.000Z');
    expect(
      fromJalali({ year: 1400, month: 3, day: 11 }, { hour: 16, minute: 30 }).toISOString(),
    ).toBe('2021-06-01T12:00:00.000Z');
  });

  it('moves a wall time skipped by daylight saving one hour later', () => {
    // 2 Farvardin 1400: clocks went from 00:00 to 01:00, so 00:30 never happened.
    const instant = fromJalali({ year: 1400, month: 1, day: 2 }, { hour: 0, minute: 30 });
    expect(instant.toISOString()).toBe('2021-03-21T21:00:00.000Z');
    expect(toJalaliDateTime(instant)).toMatchObject({ day: 2, hour: 1, minute: 30 });
  });

  it('takes the first of a wall time repeated when daylight saving ended', () => {
    // 30 Shahrivar 1400: clocks went from 24:00 back to 23:00, so 23:30 happened twice.
    const instant = fromJalali({ year: 1400, month: 6, day: 30 }, { hour: 23, minute: 30 });
    expect(instant.toISOString()).toBe('2021-09-21T19:00:00.000Z');
  });

  it('round-trips every hour of 1400 and 1405, except the skipped one', () => {
    for (const year of [1400, 1405]) {
      for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= jalaliMonthLength(year, month); day++) {
          for (let hour = 0; hour < 24; hour++) {
            if (year === 1400 && month === 1 && day === 2 && hour === 0) continue;
            const back = toJalaliDateTime(fromJalali({ year, month, day }, { hour }));
            if (
              back.year !== year ||
              back.month !== month ||
              back.day !== day ||
              back.hour !== hour
            ) {
              throw new Error(
                `round trip failed at ${String(year)}/${String(month)}/${String(day)} ${String(hour)}:00`,
              );
            }
          }
        }
      }
    }
  });

  it('rejects invalid dates and times', () => {
    expect(() => fromJalali({ year: 1404, month: 12, day: 30 })).toThrow(RangeError);
    expect(() => fromJalali({ year: 1405, month: 1, day: 1 }, { hour: 24 })).toThrow(RangeError);
    expect(() => fromJalali({ year: 1405, month: 1, day: 1 }, { hour: 10, minute: 60 })).toThrow(
      RangeError,
    );
  });
});
