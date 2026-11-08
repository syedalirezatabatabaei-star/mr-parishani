import { describe, expect, it } from 'vitest';
import { allocate, buildStatement, lastClosedPeriod, statementPeriod } from './statements.js';

describe("a doctor's monthly statement (task 5-4; doc 06 §2)", () => {
  it('services less fees, cash fees, what was carried and other deductions', () => {
    expect(
      buildStatement({
        payables: [6_000_000n, 3_000_000n],
        creditFees: [600_000n, 300_000n],
        cashFees: [200_000n],
        carriedIn: 100_000n,
        otherDeductions: 0n,
      }),
    ).toEqual({
      grossRial: 9_000_000n,
      creditFeesRial: 900_000n,
      cashFeesRial: 200_000n,
      carriedInRial: 100_000n,
      otherDeductionsRial: 0n,
      payableRial: 7_800_000n,
      carriedOutRial: 0n,
      offsetRial: 1_200_000n,
    });
  });

  it('negative (doc 06 §8 test 3): nothing paid, the rest carried; the offset only what services cover', () => {
    const t = buildStatement({
      payables: [],
      creditFees: [],
      cashFees: [500_000n],
      carriedIn: 0n,
      otherDeductions: 0n,
    });
    expect(t).toMatchObject({ payableRial: -500_000n, carriedOutRial: 500_000n, offsetRial: 0n });
  });

  it('for 10,000 random statements: exact, never a negative offset or carry, offset + carried = deductions', () => {
    let seed = 54;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const some = (k: number, max: number) =>
      Array.from({ length: rand(k) }, () => BigInt(rand(max)));
    for (let i = 0; i < 10_000; i++) {
      const input = {
        payables: some(6, 50_000_000).map((x) => x + 1n),
        creditFees: some(6, 5_000_000),
        cashFees: some(4, 5_000_000),
        carriedIn: BigInt(rand(3_000_000)),
        otherDeductions: BigInt(rand(2) === 0 ? 0 : rand(1_000_000)),
      };
      const t = buildStatement(input);
      const deductions =
        t.creditFeesRial + t.cashFeesRial + t.carriedInRial + t.otherDeductionsRial;
      expect(t.payableRial).toBe(t.grossRial - deductions);
      expect(t.offsetRial >= 0n && t.offsetRial <= t.grossRial).toBe(true);
      expect(t.carriedOutRial >= 0n).toBe(true);
      // What the offset leaves of the deductions is exactly what is carried.
      expect(deductions - t.offsetRial).toBe(t.carriedOutRial);
      // What the offset leaves of the services is exactly what is paid.
      expect(t.grossRial - t.offsetRial).toBe(t.payableRial > 0n ? t.payableRial : 0n);
    }
  });

  it('refuses a negative part', () => {
    expect(() =>
      buildStatement({
        payables: [-1n],
        creditFees: [],
        cashFees: [],
        carriedIn: 0n,
        otherDeductions: 0n,
      }),
    ).toThrow(RangeError);
  });

  it('allocates an amount over buckets in order, none above its size', () => {
    expect(allocate(700n, [500n, 300n, 100n])).toEqual([500n, 200n, 0n]);
    expect(allocate(0n, [5n])).toEqual([0n]);
    expect(() => allocate(10n, [5n])).toThrow(RangeError);
  });
});

describe('the period of a statement', () => {
  it('is a Jalali month, from Tehran midnight to the next', () => {
    // 1 Mordad 1405 = 23 July 2026; 1 Shahrivar = 23 August 2026 (Tehran +03:30).
    expect(statementPeriod(1405, 5)).toEqual({
      start: new Date('2026-07-22T20:30:00Z'),
      end: new Date('2026-08-22T20:30:00Z'),
    });
    // Esfand into the next year.
    expect(statementPeriod(1404, 12).end).toEqual(statementPeriod(1405, 1).start);
  });

  it('drafts the month that has just closed', () => {
    expect(lastClosedPeriod(new Date('2026-08-22T21:00:00Z'))).toEqual({ year: 1405, month: 5 });
    expect(lastClosedPeriod(new Date('2026-03-21T12:00:00Z'))).toEqual({ year: 1404, month: 12 });
  });
});
