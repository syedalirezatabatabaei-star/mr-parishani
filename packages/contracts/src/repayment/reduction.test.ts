import { describe, expect, it } from 'vitest';
import { reduceFromLast, ReductionError, type ReducibleInstallment } from './reduction.js';

const month = (n: number) => `2027-${String(n).padStart(2, '0')}-10`;
const plan = (amounts: bigint[], paid: bigint[] = []): ReducibleInstallment[] =>
  amounts.map((a, n) => ({
    id: `i${String(n + 1)}`,
    index: n + 1,
    dueOn: month(n + 1),
    amountRial: a,
    paidRial: paid[n] ?? 0n,
  }));

describe('reduceFromLast (task 4-8; owner, doc 13 open item 3)', () => {
  it('takes from the last installment, then the ones before it (ب)', () => {
    expect(reduceFromLast(plan([1000n, 1000n, 1000n]), 1500n)).toEqual([
      { id: 'i3', fromRial: 1000n, toRial: 0n },
      { id: 'i2', fromRial: 1000n, toRial: 500n },
    ]);
  });

  it('never touches a paid or partly paid installment (ج, پ۶)', () => {
    const changes = reduceFromLast(plan([1000n, 1000n, 1000n, 1000n], [1000n, 0n, 1n, 0n]), 1500n);
    expect(changes).toEqual([
      { id: 'i4', fromRial: 1000n, toRial: 0n },
      { id: 'i2', fromRial: 1000n, toRial: 500n },
    ]);
  });

  it('refuses more than the untouched installments hold, whole (پ۷), and nothing at all', () => {
    expect(() => reduceFromLast(plan([1000n, 1000n], [1000n]), 1001n)).toThrow(ReductionError);
    try {
      reduceFromLast(plan([1000n, 1000n], [1000n]), 1001n);
    } catch (e) {
      expect(e).toMatchObject({ code: 'exceeds_unpaid_installments', reducibleRial: 1000n });
    }
    expect(() => reduceFromLast(plan([1000n]), 0n)).toThrow('amount_must_be_positive');
  });

  it('for 10,000 random schedules: exact, never negative, last first, paid untouched', () => {
    let seed = 1405;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let t = 0; t < 10_000; t++) {
      const count = 1 + rand(36);
      const amounts = Array.from({ length: count }, () => BigInt(1 + rand(5_000_000)));
      const paid = amounts.map((a) => (rand(4) === 0 ? (rand(2) === 0 ? a : 1n) : 0n));
      const installments = plan(amounts, paid);
      const reducible = installments
        .filter((i) => i.paidRial === 0n)
        .reduce((s, i) => s + i.amountRial, 0n);
      if (reducible === 0n) continue;
      const x = 1n + BigInt(rand(Number(reducible < 2n ** 31n ? reducible : 2n ** 31n - 1n)));
      const changes = reduceFromLast(installments, x);
      // Exact: the schedule drops by the cancelled amount, to the rial.
      expect(changes.reduce((s, c) => s + (c.fromRial - c.toRial), 0n)).toBe(x);
      for (const c of changes) {
        expect(c.toRial >= 0n).toBe(true);
        const i = installments.find((j) => j.id === c.id);
        expect(i?.paidRial).toBe(0n);
      }
      // Last first: every changed one but the earliest is taken to zero.
      for (const c of changes.slice(0, -1)) expect(c.toRial).toBe(0n);
      const indexes = changes.map((c) => Number(c.id.slice(1)));
      expect([...indexes].sort((a, b) => b - a)).toEqual(indexes);
    }
  });
});
