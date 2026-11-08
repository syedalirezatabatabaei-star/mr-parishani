import { describe, expect, it } from 'vitest';
import { isJalaliLeapYear, jalaliMonthLength } from '../jalali/calendar.js';
import { fromJalali } from '../jalali/tehran.js';
import {
  buildInstallmentSchedule,
  nominalDueOn,
  ScheduleError,
  type ScheduleInput,
} from './schedule.js';

const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  fromJalali({ year, month, day }, { hour, minute });

/** Same seed, same combinations: a failure can be replayed exactly. */
function mulberry32(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ACCEPTANCE: installments always sum to the total obligation', () => {
  it('for 10,000 random combinations of amount, count and rounding unit', () => {
    const random = mulberry32(1403);
    const units = [1n, 1_000n, 10_000n, 100_000n, 1_000_000n];
    let checked = 0;
    for (let i = 0; i < 10_000; i++) {
      const count = 1 + Math.floor(random() * 60);
      const unit = units[Math.floor(random() * units.length)] ?? 10_000n;
      // From just enough for one unit each, up to hundreds of billions of rials.
      const minimum = BigInt(count) * unit;
      const total =
        minimum + BigInt(Math.floor(random() * 1e9)) * BigInt(1 + Math.floor(random() * 500));
      const fundedAt = at(
        1403 + Math.floor(random() * 3),
        1 + Math.floor(random() * 12),
        1 + Math.floor(random() * 29),
      );
      const schedule = buildInstallmentSchedule({
        totalRial: total,
        count,
        fundedAt,
        roundingUnitRial: unit,
      });

      expect(schedule).toHaveLength(count);
      expect(schedule.reduce((sum, s) => sum + s.amountRial, 0n)).toBe(total);
      // The rounded base (with one installment, the first is base + remainder).
      const base = (total / (BigInt(count) * unit)) * unit;
      // Every installment but the first is the rounded base; the whole remainder is on
      // the first; nothing is zero.
      expect(base % unit).toBe(0n);
      expect(base).toBeGreaterThan(0n);
      for (const s of schedule.slice(1)) expect(s.amountRial).toBe(base);
      expect((schedule[0]?.amountRial ?? 0n) - base).toBeLessThan(BigInt(count) * unit);
      expect(schedule[0]?.amountRial).toBeGreaterThanOrEqual(base);
      checked++;
    }
    expect(checked).toBe(10_000);
    // About 3 s alone; more when the whole workspace tests in parallel.
  }, 60_000);

  it('rounds down, remainder to the first (doc 02 §5)', () => {
    const schedule = buildInstallmentSchedule({
      totalRial: 1_000_000_007n,
      count: 12,
      fundedAt: at(1405, 1, 10),
      roundingUnitRial: 10_000n,
    });
    // 1,000,000,007 / 12 = 83,333,333.9 → 83,330,000; remainder 40,007 on the first.
    expect(schedule.map((s) => s.amountRial)).toEqual([
      83_370_007n,
      ...Array.from({ length: 11 }, () => 83_330_000n),
    ]);
  });
});

describe('ACCEPTANCE: due dates in months of 31, 30 and 29 days', () => {
  const dueDays = (fundedAt: Date, count = 12) =>
    buildInstallmentSchedule({
      totalRial: 120n * 10_000n,
      count,
      fundedAt,
      roundingUnitRial: 10_000n,
    }).map((s) => s.dueJalali);

  it('the 31st stays the 31st in 31-day months and is the last day in shorter ones', () => {
    // Doc 02: 31 Farvardin → 31 Ordibehesht … → 30 Mehr (30-day month).
    const due = dueDays(at(1405, 1, 31));
    expect(due.slice(0, 6).map((d) => d.day)).toEqual([31, 31, 31, 31, 31, 30]);
    expect(due[5]).toEqual({ year: 1405, month: 7, day: 30 });
    // Back to 31 after a short month: computed from the funding day, never chained.
    expect(due[11]).toEqual({ year: 1406, month: 1, day: 31 });
    for (const d of due) expect(d.day).toBe(Math.min(31, jalaliMonthLength(d.year, d.month)));
  });

  it('30 Mehr → 29 Esfand in a common year, 30 Esfand in a leap year', () => {
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(isJalaliLeapYear(1404)).toBe(false);
    expect(dueDays(at(1403, 7, 30), 5)[4]).toEqual({ year: 1403, month: 12, day: 30 });
    expect(dueDays(at(1404, 7, 30), 5)[4]).toEqual({ year: 1404, month: 12, day: 29 });
  });

  it('funded on 30 Esfand of a leap year: the 30th returns wherever it exists', () => {
    const due = dueDays(at(1403, 12, 30));
    expect(due[0]).toEqual({ year: 1404, month: 1, day: 30 });
    expect(due[6]).toEqual({ year: 1404, month: 7, day: 30 });
    expect(due[11]).toEqual({ year: 1404, month: 12, day: 29 });
  });

  it('every due day of every funding day of three years obeys the rule', () => {
    for (let year = 1403; year <= 1405; year++) {
      for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= jalaliMonthLength(year, month); day++) {
          for (const d of dueDays(at(year, month, day), 13)) {
            expect(d.day).toBe(Math.min(day, jalaliMonthLength(d.year, d.month)));
          }
        }
      }
    }
  });

  it('uses the funding day in Tehran, not in UTC', () => {
    // 00:10 on 1 Ordibehesht in Tehran is still the previous day in UTC.
    const justAfterMidnight = at(1405, 2, 1, 0, 10);
    // 1 Ordibehesht 1405 00:10 in Tehran = 20 April 2026 20:40 UTC.
    expect(justAfterMidnight.toISOString()).toBe('2026-04-20T20:40:00.000Z');
    expect(dueDays(justAfterMidnight, 1)[0]).toEqual({ year: 1405, month: 3, day: 1 });
    // 23:50 on 31 Farvardin in Tehran: still the 31st.
    expect(dueDays(at(1405, 1, 31, 23, 50), 1)[0]).toEqual({ year: 1405, month: 2, day: 31 });
  });

  it('stores the Gregorian day of each Jalali due day', () => {
    const [first] = buildInstallmentSchedule({
      totalRial: 10_000n,
      count: 1,
      fundedAt: at(1405, 1, 1),
      roundingUnitRial: 10_000n,
    });
    // 1 Ordibehesht 1405 = 21 April 2026.
    expect(first?.dueOn).toBe('2026-04-21');
  });
});

describe('hard rules', () => {
  const valid: ScheduleInput = {
    totalRial: 1_200_000n,
    count: 12,
    fundedAt: at(1405, 1, 1),
    roundingUnitRial: 10_000n,
  };
  const code = (input: ScheduleInput) => {
    try {
      buildInstallmentSchedule(input);
      return null;
    } catch (error) {
      return error instanceof ScheduleError ? error.code : 'other';
    }
  };

  it('refuses a total too small for the count: never a zero installment', () => {
    expect(code({ ...valid, totalRial: 119_999n })).toBe('total_too_small_for_count');
    expect(code({ ...valid, totalRial: 120_000n })).toBeNull();
  });

  it('refuses a JS number, a bad count or unit', () => {
    expect(code({ ...valid, totalRial: 1_200_000 as unknown as bigint })).toBe(
      'amount_must_be_bigint_rial',
    );
    expect(code({ ...valid, count: 0 })).toBe('invalid_installment_count');
    expect(code({ ...valid, count: 2.5 })).toBe('invalid_installment_count');
    expect(code({ ...valid, roundingUnitRial: 0n })).toBe('invalid_rounding_unit');
    expect(code({ ...valid, fundedAt: new Date(Number.NaN) })).toBe('invalid_funded_at');
  });
});

/**
 * Go-live M1 (ADR-039, owner 1405/07/21): the formula is unchanged; only the version of the
 * unit is the case's. These pin the formula for every count and the plan's own numbers.
 */
describe('M1: exact sum and the first installment, 1 to 360 installments', () => {
  const fundedAt = at(1405, 7, 30);
  const check = (totalRial: bigint, count: number, unit: bigint) => {
    const schedule = buildInstallmentSchedule({
      totalRial,
      count,
      fundedAt,
      roundingUnitRial: unit,
    });
    const base = (totalRial / BigInt(count) / unit) * unit;
    const remainder = totalRial - base * BigInt(count);
    expect(schedule).toHaveLength(count);
    expect(schedule.reduce((sum, s) => sum + s.amountRial, 0n)).toBe(totalRial);
    expect(schedule[0]?.amountRial).toBe(base + remainder);
    for (const s of schedule.slice(1)) expect(s.amountRial).toBe(base);
    expect(remainder).toBeGreaterThanOrEqual(0n);
    expect(remainder).toBeLessThan(BigInt(count) * unit);
    expect(base % unit).toBe(0n);
    expect(base).toBeGreaterThan(0n);
  };

  it('every count from 1 to 360, with a total the count divides and one it does not', () => {
    for (let count = 1; count <= 360; count++) {
      for (const unit of [10_000n, 100_000n]) {
        const divisible = BigInt(count) * unit * 37n;
        check(divisible, count, unit);
        check(divisible + 7n, count, unit);
        check(1_000_000_007n, count, unit);
      }
    }
  }, 60_000);

  it('the counts of the plan: 1, 2, 3, 6, 12, 18, 24, 36, 60 and 360', () => {
    for (const count of [1, 2, 3, 6, 12, 18, 24, 36, 60, 360]) {
      check(50_000_000n * 36n, count, 10_000n);
      check(50_000_000n * 36n + 9_999n, count, 10_000n);
    }
  });
});

describe('M1: small amounts', () => {
  const fundedAt = at(1405, 7, 30);
  const amounts = (totalRial: bigint, count: number, unit: bigint) =>
    buildInstallmentSchedule({ totalRial, count, fundedAt, roundingUnitRial: unit }).map(
      (s) => s.amountRial,
    );

  it('n × unit: all equal, no remainder', () => {
    for (const count of [1, 2, 12, 360]) {
      expect(amounts(BigInt(count) * 10_000n, count, 10_000n)).toEqual(
        Array.from({ length: count }, () => 10_000n),
      );
    }
  });

  it('n × unit + 1: the first is one rial more', () => {
    for (const count of [1, 2, 12, 360]) {
      expect(amounts(BigInt(count) * 10_000n + 1n, count, 10_000n)).toEqual([
        10_001n,
        ...Array.from({ length: count - 1 }, () => 10_000n),
      ]);
    }
  });

  it('n × unit − 1: refused, never a zero installment', () => {
    for (const count of [1, 2, 12, 360]) {
      expect(() => amounts(BigInt(count) * 10_000n - 1n, count, 10_000n)).toThrow(
        expect.objectContaining({ code: 'total_too_small_for_count' }) as unknown,
      );
    }
  });

  it('one rial, one installment, a unit of one rial', () => {
    expect(amounts(1n, 1, 1n)).toEqual([1n]);
  });
});

describe('M1: the numbers of the plan (go-live-m1-rounding-version-plan.md §1)', () => {
  const funded = at(1405, 7, 30);
  const plan = (totalRial: bigint, unit: bigint, fundedAt = funded) =>
    buildInstallmentSchedule({ totalRial, count: 12, fundedAt, roundingUnitRial: unit });

  it('50,000,000 in 12 with the locked unit 10,000: base 4,160,000, first 4,240,000', () => {
    const s = plan(50_000_000n, 10_000n);
    expect(s.map((i) => i.amountRial)).toEqual([
      4_240_000n,
      ...Array.from({ length: 11 }, () => 4_160_000n),
    ]);
    expect(s.reduce((sum, i) => sum + i.amountRial, 0n)).toBe(50_000_000n);
  });

  it('the same with 100,000: base 4,100,000, first 4,900,000; a different schedule', () => {
    const s = plan(50_000_000n, 100_000n);
    expect(s.map((i) => i.amountRial)).toEqual([
      4_900_000n,
      ...Array.from({ length: 11 }, () => 4_100_000n),
    ]);
    expect(s.reduce((sum, i) => sum + i.amountRial, 0n)).toBe(50_000_000n);
  });

  it('125,000 in 12: 15,000 then 10,000 with 10,000; refused with 100,000', () => {
    expect(plan(125_000n, 10_000n).map((i) => i.amountRial)).toEqual([
      15_000n,
      ...Array.from({ length: 11 }, () => 10_000n),
    ]);
    expect(() => plan(125_000n, 100_000n)).toThrow(
      expect.objectContaining({ code: 'total_too_small_for_count' }) as unknown,
    );
  });

  it('due days: funded 30 Mehr 1405 and 31 Farvardin 1405', () => {
    expect(
      plan(50_000_000n, 10_000n)
        .slice(0, 6)
        .map((i) => i.dueJalali),
    ).toEqual([
      { year: 1405, month: 8, day: 30 },
      { year: 1405, month: 9, day: 30 },
      { year: 1405, month: 10, day: 30 },
      { year: 1405, month: 11, day: 30 },
      { year: 1405, month: 12, day: 29 },
      { year: 1406, month: 1, day: 30 },
    ]);
    expect(
      plan(50_000_000n, 10_000n, at(1405, 1, 31))
        .slice(0, 7)
        .map((i) => i.dueJalali),
    ).toEqual([
      { year: 1405, month: 2, day: 31 },
      { year: 1405, month: 3, day: 31 },
      { year: 1405, month: 4, day: 31 },
      { year: 1405, month: 5, day: 31 },
      { year: 1405, month: 6, day: 31 },
      { year: 1405, month: 7, day: 30 },
      { year: 1405, month: 8, day: 30 },
    ]);
  });
});

describe('the nominal due day, read only (owner 1405/07/24)', () => {
  it('is the day the schedule gives before any move, for every installment, across years', () => {
    // Funding days over 1403 to 1410, at hours on both sides of Tehran midnight in UTC.
    for (let year = 1403; year <= 1410; year++) {
      for (const month of [1, 6, 7, 11, 12]) {
        const last = jalaliMonthLength(year, month);
        for (const day of [1, 29, last]) {
          for (const hour of [0, 3, 23]) {
            const fundedAt = fromJalali({ year, month, day: Math.min(day, last) }, { hour });
            const built = buildInstallmentSchedule({
              totalRial: 36_000_000n,
              count: 36,
              fundedAt,
              roundingUnitRial: 10_000n,
            });
            for (const i of built) expect(nominalDueOn(fundedAt, i.index)).toBe(i.dueOn);
          }
        }
      }
    }
  });
});
