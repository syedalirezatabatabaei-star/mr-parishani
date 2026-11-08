import { describe, expect, it } from 'vitest';
import { ScheduleError } from '../repayment/schedule.js';
import {
  amountOf,
  creditPlanSchema,
  creditPlansSchema,
  originationBase,
  originationReduction,
  plansFor,
  quote,
  QuoteError,
  type CreditPlan,
  type QuoteInput,
} from './plans.js';

const doctor = '0190a000-0000-7000-8000-000000000001';
const plan = (over: Partial<CreditPlan> = {}): CreditPlan =>
  creditPlanSchema.parse({
    code: 'dental_12',
    title: 'طرح دندانپزشکی ۱۲ ماهه',
    active: true,
    cityCode: 'isfahan',
    treatmentFieldCodes: ['dentistry'],
    doctorIds: null,
    minAmountRial: '10000000',
    maxAmountRial: '500000000',
    downPayment: { basis: 'percent', bps: 2000 },
    installmentCounts: [6, 9, 12],
    planFee: { basis: 'percent', bps: 1500, timing: 'spread' },
    originationFee: { basis: 'fixed', rial: '2000000' },
    ...over,
  });
const input = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  proformaTotalRial: 100_000_000n,
  installmentCount: 12,
  roundingUnitRial: 10_000n,
  fundedAt: new Date('2026-10-02T08:00:00Z'),
  allowPatientAmountReduction: false,
  ...over,
});
const sum = (xs: readonly { amountRial: bigint }[]) => xs.reduce((s, x) => s + x.amountRial, 0n);

describe('a credit plan (doc 10 §3)', () => {
  it('has no field for VAT, a late penalty or an early-settlement discount, even by data', () => {
    for (const extra of ['vatBps', 'latePenaltyBps', 'earlySettlementDiscountBps']) {
      expect(creditPlanSchema.safeParse({ ...plan(), [extra]: 100 }).success).toBe(false);
    }
    expect(
      creditPlanSchema.safeParse({
        ...plan(),
        planFee: { basis: 'percent', bps: 100, timing: 'spread', vat: true },
      }).success,
    ).toBe(false);
  });

  it('refuses a minimum above the maximum, repeated counts and repeated codes', () => {
    expect(
      creditPlanSchema.safeParse({ ...plan(), minAmountRial: '9', maxAmountRial: '8' }).success,
    ).toBe(false);
    expect(creditPlanSchema.safeParse({ ...plan(), installmentCounts: [12, 6] }).success).toBe(
      false,
    );
    expect(creditPlansSchema.safeParse({ plans: [plan(), plan()] }).success).toBe(false);
    expect(creditPlansSchema.safeParse({ plans: [] }).success).toBe(true);
  });

  it('is offered only where it fits: active, city, field, doctor and amount', () => {
    const fit = {
      cityCode: 'isfahan',
      treatmentFieldCode: 'dentistry',
      doctorId: doctor,
      amountRial: 80_000_000n,
    };
    const plans = [
      plan(),
      plan({ code: 'off', active: false }),
      plan({ code: 'tehran', cityCode: 'tehran' }),
      plan({ code: 'everywhere', cityCode: null }),
      plan({ code: 'eyes', treatmentFieldCodes: ['ophthalmology'] }),
      plan({ code: 'other_doctor', doctorIds: ['0190a000-0000-7000-8000-000000000002'] }),
      plan({ code: 'this_doctor', doctorIds: [doctor] }),
      plan({ code: 'big', minAmountRial: '100000000' }),
    ];
    expect(plansFor(plans, fit).map((p) => p.code)).toEqual([
      'dental_12',
      'everywhere',
      'this_doctor',
    ]);
  });
});

describe('quote (doc 10 §3)', () => {
  it('splits a proforma into down payment, loan, fees and installments of the phase 1 generator', () => {
    const q = quote(plan(), input());
    expect(q.downPaymentRial).toBe(20_000_000n);
    expect(q.financeableRial).toBe(80_000_000n);
    expect(q.loanRial).toBe(80_000_000n);
    expect(q.planFeeRial).toBe(12_000_000n);
    expect(q.originationFeeRial).toBe(2_000_000n);
    expect(q.dueAtCompletionRial).toBe(2_000_000n);
    expect(q.totalObligationRial).toBe(92_000_000n);
    expect(q.installments).toHaveLength(12);
    expect(sum(q.installments)).toBe(92_000_000n);
    // Rounded down to the unit, the remainder (92M − 12 × 7.66M = 80,000) on the first (doc 02 §5).
    expect(q.installments.map((i) => i.amountRial).slice(0, 3)).toEqual([
      7_740_000n,
      7_660_000n,
      7_660_000n,
    ]);
    expect(q.installments[0]?.dueOn).toBe('2026-11-01');
    expect(q.totalPayableRial).toBe(20_000_000n + 2_000_000n + 92_000_000n);
  });

  it('leaves a plan fee paid at completion out of the installments', () => {
    const q = quote(
      plan({ planFee: { basis: 'percent', bps: 1500, timing: 'at_completion' } }),
      input(),
    );
    expect(q.totalObligationRial).toBe(80_000_000n);
    expect(sum(q.installments)).toBe(80_000_000n);
    expect(q.dueAtCompletionRial).toBe(14_000_000n);
    expect(q.totalPayableRial).toBe(20_000_000n + 14_000_000n + 80_000_000n);
  });

  it('reduces the loan only when the configuration allows it; the rest is cash to the doctor', () => {
    expect(() => quote(plan(), input({ requestedAmountRial: 60_000_000n }))).toThrow(QuoteError);
    const q = quote(
      plan(),
      input({ requestedAmountRial: 60_000_000n, allowPatientAmountReduction: true }),
    );
    expect([q.loanRial, q.cashTopUpRial, q.planFeeRial]).toEqual([
      60_000_000n,
      20_000_000n,
      9_000_000n,
    ]);
    expect(() =>
      quote(plan(), input({ requestedAmountRial: 90_000_000n, allowPatientAmountReduction: true })),
    ).toThrow(QuoteError);
    // Asking for exactly the financeable amount is no reduction.
    expect(quote(plan(), input({ requestedAmountRial: 80_000_000n })).cashTopUpRial).toBe(0n);
  });

  it('refuses what the plan does not offer', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof QuoteError || e instanceof ScheduleError ? e.code : 'other';
      }
      return 'none';
    };
    expect(code(() => quote(plan(), input({ installmentCount: 7 })))).toBe(
      'installment_count_not_in_plan',
    );
    expect(code(() => quote(plan({ active: false }), input()))).toBe('plan_inactive');
    expect(code(() => quote(plan(), input({ proformaTotalRial: 5_000_000n })))).toBe(
      'amount_outside_plan',
    );
    expect(
      code(() => quote(plan({ downPayment: { basis: 'fixed', rial: '100000000' } }), input())),
    ).toBe('down_payment_exceeds_total');
    expect(code(() => quote(plan({ minAmountRial: '1' }), input({ proformaTotalRial: 10n })))).toBe(
      'total_too_small_for_count',
    );
  });

  it('rounds a share down to the whole rial (TODO(decision), task 3-3)', () => {
    expect(amountOf({ basis: 'percent', bps: 1500 }, 99_999n)).toBe(14_999n);
    expect(amountOf({ basis: 'fixed', rial: '7' }, 99_999n)).toBe(7n);
  });

  it('ADR-035: a rounded plan gives whole tomans; the loan is the share minus the down payment', () => {
    expect(amountOf({ basis: 'percent', bps: 1500 }, 99_999n, 10n)).toBe(14_990n);
    expect(amountOf({ basis: 'fixed', rial: '70' }, 99_999n, 10n)).toBe(70n);
    // A share of 123,456,770 rials (12,345,677 tomans): 20% would be 24,691,354 rials.
    const q = quote(
      plan({ percentRoundingRial: '10' }),
      input({ proformaTotalRial: 123_456_770n, installmentCount: 12 }),
    );
    expect(q.downPaymentRial).toBe(24_691_350n);
    expect(q.loanRial).toBe(123_456_770n - 24_691_350n);
    expect(q.percentRoundingRial).toBe(10n);
    for (const v of [q.downPaymentRial, q.loanRial, q.planFeeRial, q.totalObligationRial]) {
      expect(v % 10n).toBe(0n);
    }
    for (const i of q.installments) expect(i.amountRial % 10n).toBe(0n);
    // An older plan keeps whole rials.
    const old = quote(plan(), input({ proformaTotalRial: 123_456_770n, installmentCount: 12 }));
    expect(old.downPaymentRial).toBe(24_691_354n);
    expect(old.percentRoundingRial).toBeNull();
  });

  it('ADR-035: a rounded plan refuses a fixed amount that is not whole tomans', () => {
    expect(() =>
      plan({ percentRoundingRial: '10', originationFee: { basis: 'fixed', rial: '2000005' } }),
    ).toThrow();
  });
});

describe('quote, every combination (doc 10 §10 test 6)', () => {
  /** A deterministic generator, so a failure can be replayed. */
  function random(seed: number) {
    let s = seed >>> 0;
    return (n: number) => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s % n;
    };
  }

  it('installments add up to the total obligation; the proforma is split exactly', () => {
    const next = random(1405_07_10);
    const amount = () => BigInt(next(1_000_000)) * 10_000n + BigInt(next(10_000));
    const rule = () =>
      next(2) === 0
        ? { basis: 'percent' as const, bps: next(5001) }
        : { basis: 'fixed' as const, rial: String(next(5_000_000)) };
    let built = 0;
    let refused = 0;
    for (let i = 0; i < 12_000; i++) {
      const counts = [...new Set([1 + next(36), 1 + next(36), 1 + next(60)])].sort((a, b) => a - b);
      const p = plan({
        minAmountRial: '1',
        maxAmountRial: '999999999999999',
        downPayment: rule(),
        installmentCounts: counts,
        planFee: { ...rule(), timing: next(2) === 0 ? 'spread' : 'at_completion' },
        originationFee: rule(),
      });
      const total = 1n + amount();
      const unit = [1n, 1_000n, 10_000n, 100_000n][next(4)] ?? 10_000n;
      const n = counts[next(counts.length)] ?? 1;
      try {
        const q = quote(
          p,
          input({ proformaTotalRial: total, installmentCount: n, roundingUnitRial: unit }),
        );
        built += 1;
        expect(sum(q.installments)).toBe(q.totalObligationRial);
        expect(q.installments).toHaveLength(n);
        expect(q.downPaymentRial + q.loanRial + q.cashTopUpRial).toBe(total);
        expect(q.totalObligationRial).toBe(
          q.loanRial + (q.planFeeTiming === 'spread' ? q.planFeeRial : 0n),
        );
        for (const v of [
          q.downPaymentRial,
          q.planFeeRial,
          q.originationFeeRial,
          ...q.installments.map((x) => x.amountRial),
        ]) {
          expect(v >= 0n).toBe(true);
        }
        expect(q.installments.slice(1).every((x) => x.amountRial % unit === 0n)).toBe(true);
      } catch (e) {
        // The only refusals: nothing left to finance, or too little for the count.
        if (e instanceof QuoteError) expect(e.code).toBe('down_payment_exceeds_total');
        else if (e instanceof ScheduleError) expect(e.code).toBe('total_too_small_for_count');
        else throw e;
        refused += 1;
      }
    }
    expect(built).toBeGreaterThanOrEqual(10_000);
    expect(built + refused).toBe(12_000);
    // Twelve thousand schedules with their Jalali due dates: about 4 s alone, more beside
    // the other test files.
  }, 60_000);
});

describe('ADR-048: the origination fee, its base and its reductions', () => {
  // The annex: 3% of the whole invoice; 2% waived with 5 cheques; up to 1% by an officer.
  const annex = (over: Partial<CreditPlan> = {}) =>
    plan({
      percentRoundingRial: '10',
      originationFee: { basis: 'percent', bps: 300, base: 'proforma' },
      originationChequeWaiver: { minCheques: 5, bps: 200 },
      originationOfficerDiscountBps: 100,
      ...over,
    });
  const reduce = (p: CreditPlan, cheques: number, discountBps: number) => {
    const fee = quote(p, input()).originationFeeRial;
    return originationReduction(p, {
      feeRial: fee,
      baseRial: originationBase(p, { proformaTotalRial: 100_000_000n, loanRial: 80_000_000n }),
      checkedBorrowerCheques: cheques,
      discountBps,
    });
  };

  it('takes 3% of the whole invoice with base proforma, and of the loan without it', () => {
    expect(quote(annex(), input()).originationFeeRial).toBe(3_000_000n);
    const loanBased = annex({ originationFee: { basis: 'percent', bps: 300 } });
    expect(quote(loanBased, input()).originationFeeRial).toBe(2_400_000n);
    const explicit = annex({ originationFee: { basis: 'percent', bps: 300, base: 'loan' } });
    expect(quote(explicit, input()).originationFeeRial).toBe(2_400_000n);
  });

  it('waives 2% from the fifth checked cheque and never below it', () => {
    expect(reduce(annex(), 4, 0)).toMatchObject({ waiverBps: 0, netRial: 3_000_000n });
    expect(reduce(annex(), 5, 0)).toMatchObject({ waiverBps: 200, netRial: 1_000_000n });
    expect(reduce(annex(), 9, 0)).toMatchObject({ waiverBps: 200, netRial: 1_000_000n });
  });

  it('adds the waiver and the discount, at most the fee: 3% with both is 0, never negative', () => {
    expect(reduce(annex(), 0, 100)).toMatchObject({ discountBps: 100, netRial: 2_000_000n });
    expect(reduce(annex(), 5, 100).netRial).toBe(0n);
    const big = annex({ originationChequeWaiver: { minCheques: 1, bps: 300 } });
    expect(reduce(big, 1, 100).netRial).toBe(0n);
  });

  it('gives a six-month plan (no waiver) only the discount: 3% to 2%', () => {
    const six = annex({ originationChequeWaiver: undefined });
    expect(reduce(six, 12, 0).netRial).toBe(3_000_000n);
    expect(reduce(six, 12, 100).netRial).toBe(2_000_000n);
  });

  it("refuses a discount above the plan's and any reduction of a fixed fee", () => {
    expect(() => reduce(annex(), 0, 101)).toThrow(QuoteError);
    expect(() => reduce(annex({ originationOfficerDiscountBps: undefined }), 0, 1)).toThrow(
      QuoteError,
    );
    expect(() =>
      plan({
        originationFee: { basis: 'fixed', rial: '2000000' },
        originationOfficerDiscountBps: 1,
      }),
    ).toThrow();
    expect(() =>
      plan({
        originationFee: { basis: 'fixed', rial: '2000000' },
        originationChequeWaiver: { minCheques: 5, bps: 200 },
      }),
    ).toThrow();
    const fixed = plan();
    expect(
      originationReduction(fixed, {
        feeRial: 2_000_000n,
        baseRial: 80_000_000n,
        checkedBorrowerCheques: 9,
        discountBps: 0,
      }).netRial,
    ).toBe(2_000_000n);
  });

  it('keeps 0 ≤ net ≤ fee and rounds once to whole tomans, over seeded inputs', () => {
    let seed = 1405_07_30;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 1_000; i++) {
      const feeBps = 1 + next(1_000);
      const p = annex({
        originationFee: { basis: 'percent', bps: feeBps, base: 'proforma' },
        originationChequeWaiver: { minCheques: 1 + next(10), bps: 1 + next(1_000) },
        originationOfficerDiscountBps: 1 + next(500),
      });
      const base = 1n + BigInt(next(1_000_000_000));
      const fee = amountOf(p.originationFee, base, 10n);
      const r = originationReduction(p, {
        feeRial: fee,
        baseRial: base,
        checkedBorrowerCheques: next(12),
        discountBps: next((p.originationOfficerDiscountBps ?? 0) + 1),
      });
      expect(r.netRial >= 0n && r.netRial <= fee).toBe(true);
      expect(r.netRial % 10n).toBe(0n);
    }
  });

  it('offers a club plan only to a member', () => {
    const club = annex({ code: 'club_10', requiresClubMembership: true });
    const fit = { cityCode: 'isfahan', treatmentFieldCode: 'dentistry', doctorId: doctor };
    expect(plansFor([club, annex()], fit).map((p) => p.code)).toEqual(['dental_12']);
    expect(plansFor([club], { ...fit, clubMember: false })).toEqual([]);
    expect(plansFor([club], { ...fit, clubMember: true }).map((p) => p.code)).toEqual(['club_10']);
    expect(plansFor([annex({ requiresClubMembership: false })], fit)).toHaveLength(1);
  });
});

describe('ADR-050: a loan on the wage only', () => {
  // The annex's 07-220012: 12 installments, 18% down payment on the whole, no plan fee.
  const wagePlan = (over: Partial<CreditPlan> = {}) =>
    plan({
      financeableBasis: 'wage',
      downPayment: { basis: 'percent', bps: 1800 },
      planFee: { basis: 'percent', bps: 0, timing: 'spread' },
      originationFee: { basis: 'percent', bps: 300, base: 'proforma' },
      ...over,
    });

  it('finances W less the down payment on T; the materials are cash to the doctor', () => {
    const q = quote(wagePlan(), input({ wageRial: 80_000_000n }));
    expect(q.downPaymentRial).toBe(18_000_000n);
    expect(q.financeableRial).toBe(62_000_000n);
    expect(q.loanRial).toBe(62_000_000n);
    expect(q.materialCashRial).toBe(20_000_000n);
    expect(q.cashTopUpRial).toBe(20_000_000n);
    expect(q.downPaymentRial + q.loanRial + q.cashTopUpRial).toBe(100_000_000n);
    // The origination fee keeps its own base: 3% of the whole invoice.
    expect(q.originationFeeRial).toBe(3_000_000n);
    expect(q.totalPayableRial).toBe(18_000_000n + 20_000_000n + 3_000_000n + 62_000_000n);
  });

  it('refuses a down payment that reaches the wage, and a missing wage', () => {
    expect(() => quote(wagePlan(), input({ wageRial: 18_000_000n }))).toThrow(
      expect.objectContaining({ code: 'down_payment_exceeds_wage' }),
    );
    expect(() => quote(wagePlan(), input({ wageRial: 17_999_999n }))).toThrow(
      expect.objectContaining({ code: 'down_payment_exceeds_wage' }),
    );
    // A wage above the down payment is financed: here exactly the plan's minimum loan.
    expect(quote(wagePlan(), input({ wageRial: 28_000_000n })).loanRial).toBe(10_000_000n);
    expect(() => quote(wagePlan(), input())).toThrow(
      expect.objectContaining({ code: 'wage_required' }),
    );
    expect(() => quote(wagePlan(), input({ wageRial: 100_000_001n }))).toThrow(
      expect.objectContaining({ code: 'wage_required' }),
    );
  });

  it('leaves every plan financing everything as it was, a wage given or not', () => {
    for (const p of [plan(), plan({ financeableBasis: 'all' })]) {
      const before = quote(p, input());
      const withWage = quote(p, input({ wageRial: 10_000_000n }));
      expect(withWage).toEqual(before);
      expect(before.materialCashRial).toBe(0n);
    }
  });

  it('keeps D + loan + cash = T and loan + D ≤ W, a smaller loan asked or not, over seeded inputs', () => {
    let seed = 1405_08_01;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % n;
    };
    let built = 0;
    for (let i = 0; i < 2_000; i++) {
      const total = 1_000_000n + BigInt(next(1_000_000_000));
      const wage = (total * BigInt(next(10_001))) / 10_000n;
      const p = wagePlan({
        downPayment: { basis: 'percent', bps: next(5_001) },
        minAmountRial: '1',
        maxAmountRial: '999999999999999',
      });
      const ask = next(2) === 0 ? undefined : 1n + BigInt(next(Number(wage) + 1));
      try {
        const q = quote(
          p,
          input({
            proformaTotalRial: total,
            wageRial: wage,
            requestedAmountRial: ask,
            allowPatientAmountReduction: true,
          }),
        );
        built += 1;
        expect(q.downPaymentRial + q.loanRial + q.cashTopUpRial).toBe(total);
        expect(q.loanRial + q.downPaymentRial <= wage).toBe(true);
        expect(q.materialCashRial).toBe(total - wage);
        expect(q.cashTopUpRial >= q.materialCashRial).toBe(true);
      } catch (e) {
        if (!(e instanceof QuoteError) && !(e instanceof ScheduleError)) throw e;
        if (e instanceof QuoteError) {
          expect(['down_payment_exceeds_wage', 'invalid_requested_amount']).toContain(e.code);
        }
      }
    }
    expect(built).toBeGreaterThan(1_000);
  });
});
