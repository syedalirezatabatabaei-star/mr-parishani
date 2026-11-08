import { describe, expect, it } from 'vitest';
import { fromJalali } from '../jalali/tehran.js';
import {
  payableDue,
  providerContractEnded,
  providerContractEndsOn,
  providerContractSchema,
  serviceFee,
  serviceFeeRateSchema,
} from './fees.js';

describe('the service fee (task 5-1; doc 06 §3)', () => {
  it('0 by default: nothing taken', () => {
    expect(serviceFee(6_000_000n, { basis: 'percent', bps: 0 })).toBe(0n);
    expect(serviceFee(6_000_000n, { basis: 'fixed', rial: '0' })).toBe(0n);
  });

  it('a percent, rounded down to the rial (in the doctor’s favor)', () => {
    expect(serviceFee(6_000_000n, { basis: 'percent', bps: 1000 })).toBe(600_000n);
    // 1,234,567 × 2.5% = 30,864.175 → 30,864.
    expect(serviceFee(1_234_567n, { basis: 'percent', bps: 250 })).toBe(30_864n);
    expect(serviceFee(1n, { basis: 'percent', bps: 9999 })).toBe(0n);
  });

  it('a fixed amount, whatever the service', () => {
    expect(serviceFee(6_000_000n, { basis: 'fixed', rial: '150000' })).toBe(150_000n);
  });

  it('for 10,000 random amounts and rates: never negative, never more than a percent allows', () => {
    let seed = 51;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 10_000; i++) {
      const amount = BigInt(rand(2_000_000_000));
      const bps = rand(10_001);
      const fee = serviceFee(amount, { basis: 'percent', bps });
      expect(fee >= 0n).toBe(true);
      expect(fee * 10_000n <= amount * BigInt(bps)).toBe(true);
      expect((fee + 1n) * 10_000n > amount * BigInt(bps)).toBe(true);
    }
  });

  it('refuses a negative amount, and a rate out of its range', () => {
    expect(() => serviceFee(-1n, { basis: 'percent', bps: 10 })).toThrow(RangeError);
    expect(serviceFeeRateSchema.safeParse({ basis: 'percent', bps: 10_001 }).success).toBe(false);
    expect(serviceFeeRateSchema.safeParse({ basis: 'percent', bps: -1 }).success).toBe(false);
    expect(serviceFeeRateSchema.safeParse({ basis: 'fixed', rial: '-5' }).success).toBe(false);
  });
});

describe('when a payable is due (doc 14 ب; doc 06 §8 test 1)', () => {
  it('a 3-month contract: due three Jalali months later, from that day’s start in Tehran', () => {
    // Final on 15 Ordibehesht 1405 → due 15 Mordad 1405.
    const final = fromJalali({ year: 1405, month: 2, day: 15 }, { hour: 14, minute: 30 });
    const due = payableDue(final, 3);
    expect(due.dueAt).toEqual(fromJalali({ year: 1405, month: 5, day: 15 }, { hour: 0 }));
    expect(due.dueOn).toBe('2026-08-06');
  });

  it('the last-day rule of the installments: 31 Shahrivar + 1 → 30 Mehr; + 6 → 29 Esfand', () => {
    const final = fromJalali({ year: 1405, month: 6, day: 31 }, { hour: 10 });
    expect(payableDue(final, 1).dueAt).toEqual(
      fromJalali({ year: 1405, month: 7, day: 30 }, { hour: 0 }),
    );
    expect(payableDue(final, 6).dueAt).toEqual(
      fromJalali({ year: 1405, month: 12, day: 29 }, { hour: 0 }),
    );
  });

  it('refuses a cycle that is not a positive whole number of months', () => {
    expect(() => payableDue(new Date(), 0)).toThrow(RangeError);
    expect(() => payableDue(new Date(), 1.5)).toThrow(RangeError);
  });
});

describe('a doctor’s or center’s contract term (ADR-046)', () => {
  it('ends 3, 6 or 12 Jalali months after it starts; on its end day it has ended', () => {
    // 1 Mehr 1405 = 2026-09-23; 6 months → 1 Farvardin 1406 = 2027-03-21.
    const term = { startsOn: '2026-09-23', months: 6 } as const;
    expect(providerContractEndsOn(term)).toBe('2027-03-21');
    expect(providerContractEnded(term, '2027-03-20')).toBe(false);
    expect(providerContractEnded(term, '2027-03-21')).toBe(true);
    expect(providerContractEnded(term, '2027-06-01')).toBe(true);
    expect(providerContractEndsOn({ startsOn: '2026-09-23', months: 3 })).toBe('2026-12-22');
    expect(providerContractEndsOn({ startsOn: '2026-09-23', months: 12 })).toBe('2027-09-23');
  });

  it('the last day of a shorter month, as the settlement cycle', () => {
    // 31 Shahrivar 1405 (2026-09-22) + 1 month would be 31 Mehr: Mehr has 30 → 30 Mehr.
    // + 3 months: 31 Azar? Azar has 30 → 30 Azar 1405 = 2026-12-21.
    expect(providerContractEndsOn({ startsOn: '2026-09-22', months: 3 })).toBe('2026-12-21');
  });

  it('no term: nothing ends; the two fields set together or not at all', () => {
    expect(providerContractEndsOn({ startsOn: null, months: null })).toBeNull();
    expect(providerContractEnded({ startsOn: null, months: null }, '2099-01-01')).toBe(false);
    expect(providerContractSchema.safeParse({ startsOn: null, months: null }).success).toBe(true);
    expect(providerContractSchema.safeParse({ startsOn: '2026-09-23', months: 6 }).success).toBe(
      true,
    );
    expect(providerContractSchema.safeParse({ startsOn: '2026-09-23', months: null }).success).toBe(
      false,
    );
    expect(providerContractSchema.safeParse({ startsOn: null, months: 6 }).success).toBe(false);
    expect(providerContractSchema.safeParse({ startsOn: '2026-09-23', months: 4 }).success).toBe(
      false,
    );
  });
});
