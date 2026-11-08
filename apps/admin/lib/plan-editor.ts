import {
  creditPlansSchema,
  formatJalaliDate,
  formatRial,
  formatToman,
  normalizeDigits,
  quote,
  QuoteError,
  ScheduleError,
  toPersianDigits,
  type CreditPlan,
  type CreditPlans,
} from '@sepehr/contracts';
import { diffJson } from './config-diff';

/**
 * The loan plans (`credit.plans`) as a form (owner 1405/08/10). A plan's code is its identity
 * and stays; a plan is turned off, never removed (cases keep the version they chose, rule 16).
 * Every edit returns a new value, so a plan nobody touched goes back exactly as it came; the
 * schema of @sepehr/contracts and the API's plans guard check everything again.
 */

const fa = (n: number | string | bigint) => toPersianDigits(String(n));

export type Plan = CreditPlan;
type Rule = CreditPlan['downPayment'];
type FeeRule = CreditPlan['planFee'];

const edit = (plans: CreditPlans, index: number, change: (p: Plan) => void): CreditPlans => {
  const draft = structuredClone(plans);
  const plan = draft.plans[index];
  if (plan) change(plan);
  return draft;
};

/** A percent as typed (any digits, at most two decimals) in basis points; NaN otherwise. */
export function percentToBps(typed: string): number {
  const text = normalizeDigits(typed).trim().replace(/[٫]/g, '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return Number.NaN;
  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Basis points as a percent a person reads: 1800 → «۱۸». */
export const bpsToPercent = (bps: number) => fa(String(bps / 100));

/**
 * `next` in the key order of `old`, new keys after: a value typed again as it was goes back as
 * the same JSON text, key order included (the order jsonb gave it).
 */
function inOrderOf<T extends object>(old: T, next: T): T {
  const out: Record<string, unknown> = {};
  const n = next as Record<string, unknown>;
  for (const k of Object.keys(old)) if (k in n) out[k] = n[k];
  for (const k of Object.keys(n)) if (!(k in out)) out[k] = n[k];
  return out as T;
}

/** Whole rials, or '' for what is no amount (refused by the schema). */
const rialOf = (rial: bigint | null) => (rial === null || rial < 0n ? '' : rial.toString());

export const setTitle = (plans: CreditPlans, i: number, title: string) =>
  edit(plans, i, (p) => {
    p.title = title;
  });

export const setActive = (plans: CreditPlans, i: number, active: boolean) =>
  edit(plans, i, (p) => {
    p.active = active;
  });

export const setFields = (plans: CreditPlans, i: number, codes: readonly string[]) =>
  edit(plans, i, (p) => {
    p.treatmentFieldCodes = [...codes];
  });

/** null: every city. */
export const setCity = (plans: CreditPlans, i: number, city: string | null) =>
  edit(plans, i, (p) => {
    p.cityCode = city;
  });

export const setAmount = (plans: CreditPlans, i: number, end: 'min' | 'max', rial: bigint | null) =>
  edit(plans, i, (p) => {
    if (end === 'min') p.minAmountRial = rialOf(rial);
    else p.maxAmountRial = rialOf(rial);
  });

/** Installment counts, rising, each once (the schema's order). */
export const setCounts = (plans: CreditPlans, i: number, counts: readonly number[]) =>
  edit(plans, i, (p) => {
    p.installmentCounts = [...new Set(counts)].sort((a, b) => a - b);
  });

/** An amount rule from what was typed: a percent in bps, or fixed whole rials. */
function ruleOf(basis: 'percent' | 'fixed', typed: string): Rule {
  if (basis === 'percent') return { basis, bps: percentToBps(typed) };
  const text = normalizeDigits(typed).replace(/[,٬،\s]/g, '');
  return { basis, rial: /^\d{1,18}$/.test(text) ? BigInt(text).toString() : '' };
}

export const setDownPayment = (
  plans: CreditPlans,
  i: number,
  basis: 'percent' | 'fixed',
  typed: string,
) =>
  edit(plans, i, (p) => {
    p.downPayment = inOrderOf(p.downPayment, ruleOf(basis, typed));
  });

export const setPlanFee = (
  plans: CreditPlans,
  i: number,
  basis: 'percent' | 'fixed',
  typed: string,
  timing: FeeRule['timing'],
) =>
  edit(plans, i, (p) => {
    p.planFee = inOrderOf<FeeRule>(p.planFee, { ...ruleOf(basis, typed), timing });
  });

/** The origination fee; a share keeps the base it had unless one is chosen (ADR-048). */
export const setOriginationFee = (
  plans: CreditPlans,
  i: number,
  basis: 'percent' | 'fixed',
  typed: string,
  base: 'loan' | 'proforma' | undefined,
) =>
  edit(plans, i, (p) => {
    const rule = ruleOf(basis, typed);
    p.originationFee = inOrderOf(
      p.originationFee,
      rule.basis === 'percent' && base !== undefined ? { ...rule, base } : rule,
    );
  });

/** ADR-050: the plan finances only the doctor's wage lines; off leaves the key out. */
export const setWageOnly = (plans: CreditPlans, i: number, on: boolean) =>
  edit(plans, i, (p) => {
    if (on) p.financeableBasis = 'wage';
    else delete p.financeableBasis;
  });

/** ADR-048: offered only to club members; off leaves the key out. */
export const setClubOnly = (plans: CreditPlans, i: number, on: boolean) =>
  edit(plans, i, (p) => {
    if (on) p.requiresClubMembership = true;
    else delete p.requiresClubMembership;
  });

/** ADR-048: the most a completion or club officer may discount; '' leaves the key out. */
export const setOfficerDiscount = (plans: CreditPlans, i: number, typed: string) =>
  edit(plans, i, (p) => {
    if (typed.trim() === '') delete p.originationOfficerDiscountBps;
    else p.originationOfficerDiscountBps = percentToBps(typed);
  });

/** A new plan, off until it is filled in, rounded to whole tomans as the plans guard asks. */
export function addPlan(plans: CreditPlans, code: string, title: string): CreditPlans {
  const draft = structuredClone(plans);
  draft.plans.push({
    code: normalizeDigits(code).trim(),
    title,
    active: false,
    cityCode: null,
    treatmentFieldCodes: [],
    doctorIds: null,
    minAmountRial: '',
    maxAmountRial: '',
    downPayment: { basis: 'percent', bps: 0 },
    installmentCounts: [],
    planFee: { basis: 'percent', bps: 0, timing: 'spread' },
    originationFee: { basis: 'percent', bps: 0 },
    percentRoundingRial: '10',
  });
  return draft;
}

const FIELD_NAME: Readonly<Record<string, string>> = {
  code: 'کد طرح (حروف لاتین کوچک، رقم و _)',
  title: 'نام طرح',
  active: 'فعال',
  cityCode: 'شهر',
  treatmentFieldCodes: 'رشته‌های درمان (دست‌کم یکی)',
  doctorIds: 'پزشکان',
  minAmountRial: 'کف مبلغ وام',
  maxAmountRial: 'سقف مبلغ وام',
  downPayment: 'پیش‌پرداخت',
  installmentCounts: 'تعداد اقساط (دست‌کم یکی)',
  planFee: 'کارمزد طرح',
  originationFee: 'هزینه تشکیل پرونده',
  originationChequeWaiver: 'بخشودگی هزینه تشکیل با چک',
  originationOfficerDiscountBps: 'سقف تخفیف مسئول تکمیل یا باشگاه',
  requiresClubMembership: 'فقط اعضای باشگاه',
  financeableBasis: 'فقط دستمزد',
  percentRoundingRial: 'گرد کردن',
};

const REFINE: Readonly<Record<string, string>> = {
  'the minimum amount is above the maximum': 'کف مبلغ وام از سقف آن بیشتر است.',
  'installment counts must rise, each once': 'هر تعداد قسط فقط یک بار انتخاب شود.',
  'a fixed origination fee has no waiver or discount':
    'هزینه تشکیل مبلغ ثابت، بخشودگی با چک یا تخفیف مسئول نمی‌پذیرد.',
  'a fixed amount of a rounded plan must be a multiple of its rounding':
    'هر مبلغ ثابت این طرح باید تومان کامل باشد (مضرب ۱۰ ریال).',
  'a plan code appears twice': 'کد طرح تکراری است.',
};

/** Whatever keeps the plans from being proposed, in plain Persian; empty when they may be. */
export function planProblems(plans: CreditPlans): string[] {
  const parsed = creditPlansSchema.safeParse(plans);
  if (parsed.success) return [];
  const out = parsed.error.issues.map((issue) => {
    const [, index, field] = issue.path;
    const plan = typeof index === 'number' ? plans.plans[index] : undefined;
    const who = plan ? `طرح «${plan.title || plan.code}»: ` : '';
    const refine = REFINE[issue.message];
    if (refine) return `${who}${refine}`;
    const name = typeof field === 'string' ? (FIELD_NAME[field] ?? field) : 'مقدار';
    return `${who}${name} درست نیست.`;
  });
  return [...new Set(out)];
}

/** A rule as a person reads it: «۱۸٪» or «۹۹۰٬۰۰۰ ریال (۹۹٬۰۰۰ تومان)». */
export function ruleText(rule: unknown): string {
  const r = rule as { basis?: string; bps?: number; rial?: string; timing?: string; base?: string };
  if (r.basis === 'percent' && typeof r.bps === 'number') {
    const base = r.base === 'proforma' ? ' پیش‌فاکتور' : r.base === 'loan' ? ' وام' : '';
    return `${bpsToPercent(r.bps)}٪${base}${timingText(r.timing)}`;
  }
  if (r.basis === 'fixed' && typeof r.rial === 'string') {
    return `${formatRial(r.rial)} (${formatToman(r.rial)})${timingText(r.timing)}`;
  }
  return JSON.stringify(rule);
}

const timingText = (t: string | undefined) =>
  t === 'spread' ? '، در اقساط' : t === 'at_completion' ? '، نقد در تکمیل' : '';

/** One value of a plan's field in plain Persian. */
function valueText(field: string, value: unknown): string {
  // A key left out means its default (ADR-048, ADR-050).
  if (field === 'active' || field === 'requiresClubMembership') return value ? 'بله' : 'خیر';
  if (field === 'originationOfficerDiscountBps' && value === undefined) return 'ندارد';
  if (field === 'originationChequeWaiver' && value === undefined) return 'ندارد';
  if (value === undefined && field !== 'financeableBasis') return '—';
  if (field === 'financeableBasis') return value === 'wage' ? 'فقط دستمزد' : 'کل پیش‌فاکتور';
  if (field === 'minAmountRial' || field === 'maxAmountRial') {
    return typeof value === 'string' && value !== ''
      ? `${formatRial(value)} (${formatToman(value)})`
      : '—';
  }
  if (field === 'originationOfficerDiscountBps' && typeof value === 'number') {
    return `${bpsToPercent(value)}٪`;
  }
  if (field === 'installmentCounts' && Array.isArray(value)) {
    return value.map((n) => fa(String(n))).join('، ');
  }
  if (field === 'treatmentFieldCodes' && Array.isArray(value)) return value.join('، ');
  if (field === 'cityCode') return typeof value === 'string' ? value : 'همه شهرها';
  if (['downPayment', 'planFee', 'originationFee'].includes(field)) return ruleText(value);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Every change between the plans in force and the edited ones, in plain Persian. */
export function planChanges(before: CreditPlans, after: CreditPlans): string[] {
  const out: string[] = [];
  const old = new Map(before.plans.map((p) => [p.code, p]));
  for (const plan of after.plans) {
    const was = old.get(plan.code);
    if (!was) {
      out.push(`طرح تازه «${plan.title}» (${plan.code})`);
      continue;
    }
    // One line per field: a rule's basis and its amount read as one change.
    const fields = new Set(
      diffJson(was, plan)
        .map((c) => c.path[0])
        .filter((f): f is string => typeof f === 'string'),
    );
    for (const field of fields) {
      const name = FIELD_NAME[field]?.replace(/ \(.*\)$/, '') ?? field;
      const from = valueText(field, (was as unknown as Record<string, unknown>)[field]);
      const to = valueText(field, (plan as unknown as Record<string, unknown>)[field]);
      out.push(`طرح «${was.title}» › ${name}: از ${from} به ${to}`);
    }
  }
  return out;
}

/** The sample proforma of the preview: 100 million tomans. */
export const SAMPLE_PROFORMA_RIAL = 1_000_000_000n;

export interface SamplePreview {
  readonly lines: readonly { readonly label: string; readonly rial: bigint }[];
  readonly installments: readonly {
    readonly index: number;
    readonly due: string;
    readonly rial: bigint;
  }[];
}

/**
 * A plan's preview on a sample proforma of 100 million tomans, all of it wage (so a wage-only
 * plan finances the same), its first installment count, funded on `fundedAt`: the same quote
 * the patient sees (doc 10 §3), so nothing here computes money of its own.
 */
export function samplePreview(
  plan: Plan,
  count: number,
  roundingUnitRial: bigint,
  fundedAt: Date,
): SamplePreview | string {
  try {
    const q = quote(
      { ...plan, active: true },
      {
        proformaTotalRial: SAMPLE_PROFORMA_RIAL,
        installmentCount: count,
        roundingUnitRial,
        fundedAt,
        allowPatientAmountReduction: false,
        wageRial: SAMPLE_PROFORMA_RIAL,
      },
    );
    return {
      lines: [
        { label: 'پیش‌پرداخت', rial: q.downPaymentRial },
        { label: 'مبلغ وام', rial: q.loanRial },
        { label: 'کارمزد طرح', rial: q.planFeeRial },
        { label: 'هزینه تشکیل پرونده', rial: q.originationFeeRial },
        { label: 'نقد در تکمیل', rial: q.dueAtCompletionRial },
        { label: 'جمع اقساط', rial: q.totalObligationRial },
        { label: 'جمع پرداختی بیمار', rial: q.totalPayableRial },
      ],
      installments: q.installments.map((s) => ({
        index: s.index,
        due: formatJalaliDate(s.dueJalali),
        rial: s.amountRial,
      })),
    };
  } catch (error) {
    if (error instanceof QuoteError) {
      return error.code === 'amount_outside_plan'
        ? 'وام پیش‌فاکتور نمونه (۱۰۰ میلیون تومان، پس از پیش‌پرداخت) در بازه مبلغ این طرح نیست.'
        : error.code === 'down_payment_exceeds_total' || error.code === 'down_payment_exceeds_wage'
          ? 'پیش‌پرداخت چیزی برای وام باقی نمی‌گذارد.'
          : 'پیش‌نمایش این طرح ساخته نشد؛ مقدارها را بررسی کنید.';
    }
    if (error instanceof ScheduleError) return 'اقساط این طرح ساخته نشد؛ تعداد قسط را بررسی کنید.';
    return 'پیش‌نمایش این طرح ساخته نشد؛ مقدارها را بررسی کنید.';
  }
}
