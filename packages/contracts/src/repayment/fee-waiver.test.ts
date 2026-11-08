import { describe, expect, it } from 'vitest';
import { feeToWaive, planFeeShares, unearnedPlanFee } from './fee-waiver.js';
import { reduceFromLast, type ReducibleInstallment } from './reduction.js';

const month = (n: number) => `2027-${String(n).padStart(2, '0')}-10`;

describe('the plan fee waived on a cancellation after funding (task 4-8, part 7)', () => {
  it('shares: the fee over the count, rounded down, the remainder on the FIRST (owner س۱)', () => {
    expect(planFeeShares(960_000n, 12)).toEqual(Array.from({ length: 12 }, () => 80_000n));
    expect(planFeeShares(1_000n, 3)).toEqual([334n, 333n, 333n]);
    expect(planFeeShares(5n, 7)).toEqual([5n, 0n, 0n, 0n, 0n, 0n, 0n]);
    expect(() => planFeeShares(1n, 0)).toThrow(RangeError);
  });

  it("doc 02 §6, owner's example: 3 of 12 due, 240,000 kept and 720,000 waived", () => {
    const installments = Array.from({ length: 12 }, (_, n) => ({
      index: n + 1,
      dueOn: month(n + 1),
      paidRial: 0n,
    }));
    expect(feeToWaive({ feeRial: 960_000n, count: 12, installments, today: month(3) })).toBe(
      720_000n,
    );
  });

  it('never waives the fee of a paid or partly paid installment, due or not', () => {
    const installments = [
      { index: 1, dueOn: month(1), paidRial: 0n },
      { index: 2, dueOn: month(2), paidRial: 1n },
      { index: 3, dueOn: month(3), paidRial: 0n },
    ];
    // Today is before all of them: only the untouched ones (1 and 3) are waived.
    expect(feeToWaive({ feeRial: 1_000n, count: 3, installments, today: '2026-01-01' })).toBe(
      334n + 333n,
    );
  });

  it('for 10,000 random schedules: the waiver, taken off them, is exact and never negative', () => {
    let seed = 20261005;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 10_000; run++) {
      const count = 1 + rand(24);
      const fee = BigInt(rand(5_000_000));
      const shares = planFeeShares(fee, count);
      // The shares are the fee exactly, the remainder on the first.
      expect(shares.reduce((s, x) => s + x, 0n)).toBe(fee);
      expect(shares.every((x, i) => x >= 0n && (i === 0 || x === shares[1]))).toBe(true);

      // A schedule whose amounts hold the shares, some cancelled down, some paid.
      const installments: ReducibleInstallment[] = Array.from({ length: count }, (_, n) => {
        const amount = (shares[n] ?? 0n) + BigInt(rand(3_000_000));
        const paid = rand(5) === 0 ? BigInt(1 + rand(Number(amount > 0n ? amount : 1n))) : 0n;
        return {
          id: `i${String(n + 1)}`,
          index: n + 1,
          dueOn: month(n + 1),
          // A cancellation may have taken some of the last ones to zero already.
          amountRial: rand(6) === 0 && paid === 0n ? 0n : amount,
          paidRial: paid,
        };
      });
      const today = month(rand(count + 2));
      const waive = feeToWaive({ feeRial: fee, count, installments, today });

      // Never more than the fee of the installments not yet due and never paid.
      const undue = installments
        .filter((i) => i.dueOn > today && i.paidRial === 0n)
        .reduce((s, i) => s + (shares[i.index - 1] ?? 0n), 0n);
      expect(waive).toBe(undue);
      expect(waive <= fee).toBe(true);

      // Taken off the schedule up to what its untouched installments hold.
      const reducible = installments
        .filter((i) => i.paidRial === 0n)
        .reduce((s, i) => s + i.amountRial, 0n);
      const taken = waive < reducible ? waive : reducible;
      if (taken === 0n) continue;
      const changes = reduceFromLast(installments, taken);
      const total = changes.reduce((s, c) => s + (c.fromRial - c.toRial), 0n);
      expect(total).toBe(taken);
      for (const c of changes) {
        expect(c.toRial >= 0n).toBe(true);
        const before = installments.find((i) => i.id === c.id);
        // A paid installment is never touched: no fee waived, none charged again.
        expect(before?.paidRial).toBe(0n);
      }
    }
  });
});

describe('the unearned cash plan fee refunded on a cancellation after funding (ADR-045)', () => {
  const months = (n: number) =>
    Array.from({ length: n }, (_, k) => ({
      index: k + 1,
      dueOn: `2026-${String(k + 1).padStart(2, '0')}-10`,
    }));

  it('the shares of the installments not yet due; due today counts as earned', () => {
    // 1,000,003 over 4: 250,000 each, the 3 left with the first.
    const fee = 1_000_003n;
    expect(unearnedPlanFee({ feeRial: fee, installments: months(4), today: '2026-02-10' })).toBe(
      500_000n,
    );
    expect(unearnedPlanFee({ feeRial: fee, installments: months(4), today: '2026-02-09' })).toBe(
      750_000n,
    );
    // Before the first: all of it, the remainder too.
    expect(unearnedPlanFee({ feeRial: fee, installments: months(4), today: '2025-12-31' })).toBe(
      fee,
    );
    // After the last: nothing.
    expect(unearnedPlanFee({ feeRial: fee, installments: months(4), today: '2027-01-01' })).toBe(
      0n,
    );
    expect(unearnedPlanFee({ feeRial: 0n, installments: months(4), today: '2025-01-01' })).toBe(0n);
    expect(unearnedPlanFee({ feeRial: fee, installments: [], today: '2025-01-01' })).toBe(0n);
  });

  it('invariant: earned + unearned = fee, never negative, never above it, for any day', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const n = (seed % 36) + 1;
      const fee = BigInt((seed * 7919) % 50_000_000);
      const day = `2026-${String((seed % 14) + 1).padStart(2, '0')}-${String((seed % 28) + 1).padStart(2, '0')}`;
      const installments = months(Math.min(n, 12));
      const unearned = unearnedPlanFee({ feeRial: fee, installments, today: day });
      const shares = planFeeShares(fee, installments.length);
      const earned = installments
        .filter((i) => i.dueOn <= day)
        .reduce((s, i) => s + (shares[i.index - 1] ?? 0n), 0n);
      expect(unearned).toBeGreaterThanOrEqual(0n);
      expect(unearned).toBeLessThanOrEqual(fee);
      expect(earned + unearned).toBe(fee);
    }
  });

  it('matches the spread waiver when no installment is paid; an early payment does not earn it', () => {
    const fee = 900_000n;
    const installments = months(6).map((i) => ({ ...i, paidRial: 0n }));
    const today = '2026-03-15';
    expect(unearnedPlanFee({ feeRial: fee, installments, today })).toBe(
      feeToWaive({ feeRial: fee, count: 6, installments, today }),
    );
    const paidEarly = installments.map((i) => (i.index === 6 ? { ...i, paidRial: 1n } : i));
    expect(unearnedPlanFee({ feeRial: fee, installments: paidEarly, today })).toBe(450_000n);
    expect(feeToWaive({ feeRial: fee, count: 6, installments: paidEarly, today })).toBe(300_000n);
  });
});
