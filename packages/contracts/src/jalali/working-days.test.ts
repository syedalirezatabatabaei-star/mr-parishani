import { describe, expect, it } from 'vitest';
import { buildInstallmentSchedule } from '../repayment/schedule.js';
import { fromJalali, toJalali } from './tehran.js';
import {
  gregorianDayOf,
  isWorkingDay,
  nextJalaliDay,
  nextWorkingDay,
  weekdayOf,
  type WorkingCalendar,
} from './working-days.js';

const day = (year: number, month: number, d: number) => ({ year, month, day: d });
const fridayOff: WorkingCalendar = { weeklyDaysOff: ['friday'], holidays: [] };

describe('weekdays and days', () => {
  it('knows the Iranian weekday of a Jalali day', () => {
    // 1 Farvardin 1405 = Saturday 21 March 2026.
    expect(weekdayOf(day(1405, 1, 1))).toBe('saturday');
    expect(weekdayOf(day(1405, 1, 7))).toBe('friday');
  });

  it('steps over month and year ends, leap Esfand included', () => {
    expect(nextJalaliDay(day(1405, 6, 31))).toEqual(day(1405, 7, 1));
    expect(nextJalaliDay(day(1403, 12, 29))).toEqual(day(1403, 12, 30)); // leap year
    expect(nextJalaliDay(day(1403, 12, 30))).toEqual(day(1404, 1, 1));
    expect(nextJalaliDay(day(1404, 12, 29))).toEqual(day(1405, 1, 1));
  });
});

describe('isWorkingDay(date, cityCode)', () => {
  const calendar: WorkingCalendar = {
    weeklyDaysOff: ['friday'],
    holidays: [
      { on: gregorianDayOf(day(1405, 1, 12)), cityCode: null },
      { on: gregorianDayOf(day(1405, 1, 15)), cityCode: 'tabriz' },
    ],
  };

  it('weekly days off and national holidays are off everywhere', () => {
    expect(isWorkingDay(day(1405, 1, 7), 'tehran', calendar)).toBe(false); // Friday
    expect(isWorkingDay(day(1405, 1, 12), 'tehran', calendar)).toBe(false);
    expect(isWorkingDay(day(1405, 1, 12), null, calendar)).toBe(false);
    expect(isWorkingDay(day(1405, 1, 11), 'tehran', calendar)).toBe(true);
  });

  it('a city holiday is off only in that city, and not for national-only callers', () => {
    expect(isWorkingDay(day(1405, 1, 15), 'tabriz', calendar)).toBe(false);
    expect(isWorkingDay(day(1405, 1, 15), 'tehran', calendar)).toBe(true);
    expect(isWorkingDay(day(1405, 1, 15), null, calendar)).toBe(true);
  });

  it('is decided on the Tehran day, not UTC', () => {
    // 00:30 on Friday 7 Farvardin in Tehran is still Thursday in UTC.
    const instant = fromJalali(day(1405, 1, 7), { hour: 0, minute: 30 });
    expect(instant.getUTCDay()).toBe(4);
    expect(isWorkingDay(toJalali(instant), null, fridayOff)).toBe(false);
  });
});

describe('nextWorkingDay', () => {
  it('returns the day itself when it works, else the first working day after it', () => {
    expect(nextWorkingDay(day(1405, 1, 11), null, fridayOff)).toEqual(day(1405, 1, 11));
    expect(nextWorkingDay(day(1405, 1, 7), null, fridayOff)).toEqual(day(1405, 1, 8));
  });

  it('skips a run of holidays and a Friday in between', () => {
    // Nowruz: 1–4 Farvardin; 7 Farvardin is a Friday.
    const nowruz: WorkingCalendar = {
      weeklyDaysOff: ['friday'],
      holidays: [1, 2, 3, 4, 5, 6].map((d) => ({
        on: gregorianDayOf(day(1405, 1, d)),
        cityCode: null,
      })),
    };
    expect(nextWorkingDay(day(1405, 1, 1), null, nowruz)).toEqual(day(1405, 1, 8));
  });

  it('refuses a calendar with no working day at all', () => {
    const never: WorkingCalendar = {
      weeklyDaysOff: ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: [],
    };
    expect(() => nextWorkingDay(day(1405, 1, 1), null, never)).toThrow('every weekday');
  });
});

describe('installment due dates on non-working days (task 2-1)', () => {
  const base = {
    totalRial: 12_000_000n,
    count: 12,
    fundedAt: fromJalali(day(1405, 1, 17), { hour: 12 }),
    roundingUnitRial: 10_000n,
  };

  it('ACCEPTANCE: moves a due day off a holiday, and never changes an amount or the total', () => {
    const plain = buildInstallmentSchedule(base);
    // A national holiday on the first due day (17 Ordibehesht) and the day after it.
    const calendar: WorkingCalendar = {
      weeklyDaysOff: ['friday'],
      holidays: [17, 18].map((d) => ({ on: gregorianDayOf(day(1405, 2, d)), cityCode: null })),
    };
    const shifted = buildInstallmentSchedule({
      ...base,
      dueDay: (nominal) => nextWorkingDay(nominal, null, calendar),
    });
    expect(shifted.map((s) => s.amountRial)).toEqual(plain.map((s) => s.amountRial));
    expect(shifted.reduce((sum, s) => sum + s.amountRial, 0n)).toBe(base.totalRial);
    expect(plain[0]?.dueJalali).toEqual(day(1405, 2, 17));
    expect(shifted[0]?.dueJalali).not.toEqual(plain[0]?.dueJalali);
    for (const s of shifted) expect(isWorkingDay(s.dueJalali, null, calendar)).toBe(true);
    // Every due day moves forward only, and only when it was not a working day.
    shifted.forEach((s, i) => {
      const nominal = plain[i]?.dueJalali ?? s.dueJalali;
      expect(s.dueOn >= (plain[i]?.dueOn ?? '')).toBe(true);
      if (isWorkingDay(nominal, null, calendar)) expect(s.dueJalali).toEqual(nominal);
    });
  });

  it('a due-day rule that moves nothing gives exactly the schedule without one', () => {
    expect(buildInstallmentSchedule({ ...base, dueDay: (d) => d })).toEqual(
      buildInstallmentSchedule(base),
    );
  });
});

describe('a due-day rule that breaks the order', () => {
  const base = {
    totalRial: 3_000_000n,
    count: 3,
    fundedAt: fromJalali(day(1405, 1, 17), { hour: 12 }),
    roundingUnitRial: 10_000n,
  };

  it('is refused when it moves a day backward or onto the next due day', () => {
    const back = () =>
      buildInstallmentSchedule({ ...base, dueDay: (d) => ({ ...d, day: d.day - 1 }) });
    expect(back).toThrow(expect.objectContaining({ code: 'invalid_due_day' }));
    // Everything onto one far day: the second installment lands on the first one's day.
    const pile = () => buildInstallmentSchedule({ ...base, dueDay: () => day(1406, 1, 1) });
    expect(pile).toThrow(expect.objectContaining({ code: 'invalid_due_day' }));
  });
});
