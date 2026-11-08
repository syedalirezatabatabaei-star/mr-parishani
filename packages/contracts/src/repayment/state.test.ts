import { describe, expect, it } from 'vitest';
import { daysBetween, installmentState, type InstallmentState } from './state.js';

/** Phase 1's statusOf (repayment.service.ts before task 6-1), kept here as the reference. */
function phase1(dueOn: string, amount: bigint, paid: bigint, today: string): InstallmentState {
  if (amount === 0n && paid === 0n) return 'cancelled';
  if (paid >= amount) return 'paid';
  if (dueOn < today) return 'overdue';
  if (paid > 0n) return 'partially_paid';
  if (dueOn === today) return 'due';
  return 'scheduled';
}

describe("an installment's state (task 6-1; doc 15 §3)", () => {
  it('with no grace days, exactly phase 1 for 10,000 random installments', () => {
    let seed = 61;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const day = (offset: number) =>
      new Date(Date.UTC(2026, 9, 1) + offset * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 10_000; i++) {
      const due = day(rand(60));
      const today = day(rand(60));
      const amount = BigInt(rand(4) === 0 ? 0 : rand(10_000_000));
      const paid = BigInt(rand(3) === 0 ? 0 : rand(12_000_000));
      expect(installmentState(due, amount, paid, today, 0).status).toBe(
        phase1(due, amount, paid, today),
      );
    }
  });

  it('due on its day; overdue the day after, or after the grace days; days past due from the due day', () => {
    expect(installmentState('2026-10-10', 100n, 0n, '2026-10-09', 0)).toEqual({
      status: 'scheduled',
      daysPastDue: 0,
    });
    expect(installmentState('2026-10-10', 100n, 0n, '2026-10-10', 0)).toEqual({
      status: 'due',
      daysPastDue: 0,
    });
    expect(installmentState('2026-10-10', 100n, 0n, '2026-10-11', 0)).toEqual({
      status: 'overdue',
      daysPastDue: 1,
    });
    // Two grace days: still due on the first two days after it.
    expect(installmentState('2026-10-10', 100n, 0n, '2026-10-12', 2)).toEqual({
      status: 'due',
      daysPastDue: 2,
    });
    expect(installmentState('2026-10-10', 100n, 0n, '2026-10-13', 2)).toEqual({
      status: 'overdue',
      daysPastDue: 3,
    });
    expect(installmentState('2026-10-10', 100n, 40n, '2026-10-12', 2).status).toBe(
      'partially_paid',
    );
    expect(installmentState('2026-10-10', 100n, 100n, '2026-12-01', 0)).toEqual({
      status: 'paid',
      daysPastDue: 0,
    });
    expect(installmentState('2026-10-10', 0n, 0n, '2026-12-01', 0).status).toBe('cancelled');
    expect(() => installmentState('2026-10-10', 1n, 0n, '2026-10-10', -1)).toThrow(RangeError);
  });

  it('counts calendar days across months and years', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-03-01', '2026-02-28')).toBe(-1);
  });
});
