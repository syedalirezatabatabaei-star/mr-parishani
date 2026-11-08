import { creditPlansSchema, type CreditPlans } from '@sepehr/contracts';
import { describe, expect, it } from 'vitest';
import { sameJson } from './config-diff';
import {
  addPlan,
  planChanges,
  planProblems,
  samplePreview,
  setActive,
  setAmount,
  setCity,
  setClubOnly,
  setCounts,
  setDownPayment,
  setFields,
  setOfficerDiscount,
  setOriginationFee,
  setPlanFee,
  setTitle,
  setWageOnly,
} from './plan-editor';

/** Three plans of the demo, as the API gives them back (jsonb's key order). */
const STORED = JSON.parse(`{"plans": [
{"code": "eye_standard", "title": "طرح اعتبار چشم (نمونه دمو)", "active": true, "planFee": {"bps": 1800, "basis": "percent", "timing": "spread"}, "cityCode": null, "doctorIds": null, "downPayment": {"bps": 1500, "basis": "percent"}, "maxAmountRial": "1500000000", "minAmountRial": "10000000", "originationFee": {"bps": 300, "base": "proforma", "basis": "percent"}, "installmentCounts": [6, 9, 12], "percentRoundingRial": "10", "treatmentFieldCodes": ["eye"], "originationChequeWaiver": {"bps": 200, "minCheques": 5}, "originationOfficerDiscountBps": 100},
{"code": "p07_220012", "title": "زیبایی، فقط دستمزد (طرح ۰۷-۲۲۰۰۱۲، نمونه دمو)", "active": true, "planFee": {"bps": 0, "basis": "percent", "timing": "spread"}, "cityCode": null, "doctorIds": null, "downPayment": {"bps": 1800, "basis": "percent"}, "maxAmountRial": "1500000000", "minAmountRial": "10000000", "originationFee": {"bps": 300, "base": "proforma", "basis": "percent"}, "financeableBasis": "wage", "installmentCounts": [12], "percentRoundingRial": "10", "treatmentFieldCodes": ["beauty", "skin_hair"], "originationChequeWaiver": {"bps": 200, "minCheques": 5}, "originationOfficerDiscountBps": 100},
{"code": "club_six_month", "title": "طرح شش‌ماهه اعضای باشگاه (نمونه دمو)", "active": true, "planFee": {"bps": 0, "basis": "percent", "timing": "spread"}, "cityCode": null, "doctorIds": null, "downPayment": {"bps": 1000, "basis": "percent"}, "maxAmountRial": "1500000000", "minAmountRial": "10000000", "originationFee": {"bps": 300, "base": "proforma", "basis": "percent"}, "installmentCounts": [6], "percentRoundingRial": "10", "treatmentFieldCodes": ["eye", "beauty", "dental", "hearing", "slimming", "skin_hair", "infertility"], "requiresClubMembership": true, "originationOfficerDiscountBps": 100}
]}`) as CreditPlans;

const stored = () => structuredClone(STORED);

describe('the loan plans form (owner 1405/08/10)', () => {
  it('is valid as stored, and gives back exactly the same JSON when every field is typed again', () => {
    expect(creditPlansSchema.safeParse(STORED).success).toBe(true);
    let p = stored();
    p.plans.forEach((plan, i) => {
      p = setTitle(p, i, plan.title);
      p = setActive(p, i, plan.active);
      p = setFields(p, i, plan.treatmentFieldCodes);
      p = setCity(p, i, plan.cityCode);
      p = setAmount(p, i, 'min', BigInt(plan.minAmountRial));
      p = setAmount(p, i, 'max', BigInt(plan.maxAmountRial));
      p = setCounts(p, i, plan.installmentCounts);
      if (plan.downPayment.basis === 'percent') {
        p = setDownPayment(p, i, 'percent', String(plan.downPayment.bps / 100));
      }
      if (plan.planFee.basis === 'percent') {
        p = setPlanFee(p, i, 'percent', String(plan.planFee.bps / 100), plan.planFee.timing);
      }
      if (plan.originationFee.basis === 'percent') {
        p = setOriginationFee(
          p,
          i,
          'percent',
          String(plan.originationFee.bps / 100),
          plan.originationFee.base,
        );
      }
      if (plan.financeableBasis === 'wage') p = setWageOnly(p, i, true);
      if (plan.requiresClubMembership) p = setClubOnly(p, i, true);
      if (plan.originationOfficerDiscountBps !== undefined) {
        p = setOfficerDiscount(p, i, String(plan.originationOfficerDiscountBps / 100));
      }
    });
    expect(sameJson(p, STORED)).toBe(true);
    expect(planChanges(STORED, p)).toEqual([]);
    expect(planProblems(p)).toEqual([]);
  });

  it('turns typed percents in any digits into basis points, and says the change in Persian', () => {
    const p = setDownPayment(stored(), 1, 'percent', '۲۰');
    expect(p.plans[1]?.downPayment).toEqual({ basis: 'percent', bps: 2000 });
    expect(planChanges(STORED, p)).toEqual([
      'طرح «زیبایی، فقط دستمزد (طرح ۰۷-۲۲۰۰۱۲، نمونه دمو)» › پیش‌پرداخت: از ۱۸٪ به ۲۰٪',
    ]);
    const fee = setPlanFee(stored(), 0, 'percent', '12.5', 'at_completion');
    expect(planChanges(STORED, fee)).toEqual([
      'طرح «طرح اعتبار چشم (نمونه دمو)» › کارمزد طرح: از ۱۸٪، در اقساط به ۱۲.۵٪، نقد در تکمیل',
    ]);
  });

  it('turns wage-only, club-only and the officer discount off by leaving the key out', () => {
    const p = setOfficerDiscount(setClubOnly(setWageOnly(stored(), 1, false), 2, false), 0, '');
    expect('financeableBasis' in (p.plans[1] ?? {})).toBe(false);
    expect('requiresClubMembership' in (p.plans[2] ?? {})).toBe(false);
    expect('originationOfficerDiscountBps' in (p.plans[0] ?? {})).toBe(false);
    expect(planProblems(p)).toEqual([]);
    expect(planChanges(STORED, p)).toContain(
      'طرح «زیبایی، فقط دستمزد (طرح ۰۷-۲۲۰۰۱۲، نمونه دمو)» › فقط دستمزد: از فقط دستمزد به کل پیش‌فاکتور',
    );
  });

  it('refuses in Persian what the schema refuses', () => {
    const s = stored();
    expect(planProblems(setAmount(s, 0, 'min', 2_000_000_000n))).toEqual([
      'طرح «طرح اعتبار چشم (نمونه دمو)»: کف مبلغ وام از سقف آن بیشتر است.',
    ]);
    expect(planProblems(setFields(s, 0, []))).toEqual([
      'طرح «طرح اعتبار چشم (نمونه دمو)»: رشته‌های درمان (دست‌کم یکی) درست نیست.',
    ]);
    expect(planProblems(setCounts(s, 0, []))[0]).toMatch(/تعداد اقساط/);
    expect(planProblems(setDownPayment(s, 0, 'percent', '101'))[0]).toMatch(/پیش‌پرداخت درست نیست/);
    expect(planProblems(setDownPayment(s, 0, 'fixed', '1005'))[0]).toMatch(/مضرب ۱۰ ریال/);
    expect(planProblems(setTitle(s, 0, 'ا'))[0]).toMatch(/نام طرح درست نیست/);
    const added = addPlan(s, 'eye_standard', 'تکراری');
    expect(planProblems(added)).toContain('کد طرح تکراری است.');
  });

  it('adds a plan off, rounded to whole tomans, valid once it is filled in', () => {
    let p = addPlan(stored(), 'dental_24', 'دندان‌پزشکی ۲۴ ماهه');
    const i = p.plans.length - 1;
    expect(p.plans[i]).toMatchObject({ active: false, percentRoundingRial: '10' });
    expect(planProblems(p).length).toBeGreaterThan(0);
    p = setFields(p, i, ['dental']);
    p = setAmount(p, i, 'min', 10_000_000n);
    p = setAmount(p, i, 'max', 2_000_000_000n);
    p = setCounts(p, i, [24, 12]);
    p = setDownPayment(p, i, 'percent', '15');
    expect(planProblems(p)).toEqual([]);
    expect(p.plans[i]?.installmentCounts).toEqual([12, 24]);
    expect(planChanges(STORED, p)).toEqual(['طرح تازه «دندان‌پزشکی ۲۴ ماهه» (dental_24)']);
  });

  it('previews a plan on a sample proforma of 100 million tomans with the patient’s quote', () => {
    const plan = STORED.plans[0];
    if (!plan) throw new Error('fixture');
    const preview = samplePreview(plan, 12, 10_000n, new Date('2026-11-01T08:00:00Z'));
    if (typeof preview === 'string') throw new Error(preview);
    const line = (label: string) => preview.lines.find((l) => l.label === label)?.rial;
    // 15% down; the loan the rest; the plan fee 18% of the loan, spread.
    expect(line('پیش‌پرداخت')).toBe(150_000_000n);
    expect(line('مبلغ وام')).toBe(850_000_000n);
    expect(line('کارمزد طرح')).toBe(153_000_000n);
    expect(line('جمع اقساط')).toBe(1_003_000_000n);
    expect(preview.installments).toHaveLength(12);
    expect(preview.installments.reduce((s, x) => s + x.rial, 0n)).toBe(1_003_000_000n);
    expect(samplePreview({ ...plan, maxAmountRial: '100000000' }, 12, 10_000n, new Date())).toMatch(
      /در بازه مبلغ این طرح نیست/,
    );
  });
});
