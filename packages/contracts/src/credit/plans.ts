import * as z from 'zod';
import {
  buildInstallmentSchedule,
  MAX_INSTALLMENTS,
  type ScheduledInstallment,
} from '../repayment/schedule.js';

/**
 * Credit plans and their preview (doc 10 §3; task 3-3). The plans are data: the
 * versioned configuration key `credit.plans` (ADR-006), defined by the strategy manager
 * and approved by a second person. A case keeps the version it chose (rule 16), so a
 * later change to the plans never changes its preview.
 *
 * Deliberately absent (doc 10 §3): VAT, a late penalty and an early-settlement discount.
 * The schemas are strict, so no such field can be added to a plan by data either.
 */

const code = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const positiveRial = z.string().regex(/^[1-9][0-9]{0,17}$/);
const rial = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const bps = z.number().int().min(0).max(10_000);

/** An amount: a share in basis points of its base, or a fixed number of rials. */
const amountRuleSchema = z.discriminatedUnion('basis', [
  z.strictObject({ basis: z.literal('percent'), bps }),
  z.strictObject({ basis: z.literal('fixed'), rial }),
]);
export type CreditAmountRule = z.infer<typeof amountRuleSchema>;

/**
 * spread: in the total obligation and the installments (phase 1: total = principal +
 * plan fee, doc 02 §4). at_completion: paid apart, in cash, when the case is completed.
 */
const timing = z.enum(['at_completion', 'spread']);
/**
 * «هزینه تشکیل پرونده» (ADR-048): a share or fixed, like any amount, but a share names its base.
 * `loan` (the default, so every plan and case before ADR-048 is unchanged) or `proforma`: the
 * proforma's total, or the member's share of it in a group (owner 1405/07/30, answer 5).
 */
const originationFeeSchema = z.discriminatedUnion('basis', [
  z.strictObject({
    basis: z.literal('percent'),
    bps,
    base: z.enum(['loan', 'proforma']).optional(),
  }),
  z.strictObject({ basis: z.literal('fixed'), rial }),
]);
export type CreditOriginationFeeRule = z.infer<typeof originationFeeSchema>;

const positiveBps = z.number().int().min(1).max(10_000);

const planFeeSchema = z.discriminatedUnion('basis', [
  z.strictObject({ basis: z.literal('percent'), bps, timing }),
  z.strictObject({ basis: z.literal('fixed'), rial, timing }),
]);

export const creditPlanSchema = z
  .strictObject({
    code,
    title: z.string().trim().min(2).max(200),
    active: z.boolean(),
    /** null: every city. */
    cityCode: code.nullable(),
    treatmentFieldCodes: z.array(code).min(1),
    /** null: every doctor in those fields. */
    doctorIds: z.array(z.uuid()).min(1).nullable(),
    /** The loan (the amount financed) must lie in [min, max]. */
    minAmountRial: positiveRial,
    maxAmountRial: positiveRial,
    /** A share of the proforma total, or fixed. */
    downPayment: amountRuleSchema,
    installmentCounts: z.array(z.number().int().min(1).max(MAX_INSTALLMENTS)).min(1),
    /** A share of the loan, or fixed. */
    planFee: planFeeSchema,
    /** «هزینه تشکیل پرونده»: a share of its base, or fixed; always paid at completion. */
    originationFee: originationFeeSchema,
    /**
     * ADR-048: with at least `minCheques` checked cheques of the borrower, `bps` of the base is
     * waived. Absent: no waiver (the annex: not for the six-month plans).
     */
    originationChequeWaiver: z
      .strictObject({ minCheques: z.number().int().min(1).max(100), bps: positiveBps })
      .optional(),
    /** ADR-048: the most a completion or club officer may discount, in bps of the base. */
    originationOfficerDiscountBps: positiveBps.optional(),
    /** ADR-048: offered only to a member of the customer club on the case's creation day. */
    requiresClubMembership: z.boolean().optional(),
    /**
     * ADR-050: what the loan finances. `all` (the default: every plan before ADR-050): the
     * proforma less the down payment. `wage`: only the doctor's wage lines less the down payment,
     * which stays a share of the whole proforma; the materials are paid to the doctor in cash.
     */
    financeableBasis: z.enum(['all', 'wage']).optional(),
    /**
     * ADR-035: every share in basis points (down payment, plan fee, origination fee) is
     * rounded down to a multiple of this many rials, so each is a whole number of tomans;
     * the loan stays the share of the proforma minus the down payment. Required of every
     * plan added after ADR-035 (the plans guard); a plan without it keeps whole rials.
     */
    percentRoundingRial: z.literal('10').optional(),
  })
  .refine((p) => BigInt(p.minAmountRial) <= BigInt(p.maxAmountRial), {
    message: 'the minimum amount is above the maximum',
  })
  .refine((p) => p.installmentCounts.every((n, i, all) => i === 0 || n > (all[i - 1] ?? 0)), {
    message: 'installment counts must rise, each once',
  })
  .refine(
    (p) =>
      p.originationFee.basis === 'percent' ||
      (p.originationChequeWaiver === undefined && p.originationOfficerDiscountBps === undefined),
    { message: 'a fixed origination fee has no waiver or discount' },
  )
  .refine(
    (p) =>
      p.percentRoundingRial === undefined ||
      [p.downPayment, p.planFee, p.originationFee].every(
        (r) => r.basis !== 'fixed' || BigInt(r.rial) % BigInt(p.percentRoundingRial ?? '1') === 0n,
      ),
    { message: 'a fixed amount of a rounded plan must be a multiple of its rounding' },
  );
export type CreditPlan = z.infer<typeof creditPlanSchema>;

export const creditPlansSchema = z
  .strictObject({ plans: z.array(creditPlanSchema).max(500) })
  .refine((v) => new Set(v.plans.map((p) => p.code)).size === v.plans.length, {
    message: 'a plan code appears twice',
  });
export type CreditPlans = z.infer<typeof creditPlansSchema>;

/** Only the active plans that fit the case's city, field, doctor and amount (doc 10 §3). */
export function plansFor(
  plans: readonly CreditPlan[],
  fit: {
    cityCode: string;
    treatmentFieldCode: string;
    doctorId: string;
    /** The loan; omitted when it is not known yet (it depends on each plan's down payment). */
    amountRial?: bigint | undefined;
    /** ADR-048: the patient is a club member today; a club plan is offered only then. */
    clubMember?: boolean | undefined;
  },
): CreditPlan[] {
  return plans.filter(
    (p) =>
      p.active &&
      (p.requiresClubMembership !== true || fit.clubMember === true) &&
      (p.cityCode === null || p.cityCode === fit.cityCode) &&
      p.treatmentFieldCodes.includes(fit.treatmentFieldCode) &&
      (p.doctorIds === null || p.doctorIds.includes(fit.doctorId)) &&
      (fit.amountRial === undefined ||
        (fit.amountRial >= BigInt(p.minAmountRial) && fit.amountRial <= BigInt(p.maxAmountRial))),
  );
}

export class QuoteError extends Error {
  override readonly name = 'QuoteError';
  constructor(
    readonly code:
      | 'plan_inactive'
      | 'invalid_proforma_total'
      | 'down_payment_exceeds_total'
      | 'amount_reduction_not_allowed'
      | 'invalid_requested_amount'
      | 'amount_outside_plan'
      | 'installment_count_not_in_plan'
      | 'discount_not_in_plan'
      | 'down_payment_exceeds_wage'
      | 'wage_required',
    message: string,
  ) {
    super(message);
  }
}

export interface QuoteInput {
  /** The confirmed proforma's total (doc 10 §2). */
  readonly proformaTotalRial: bigint;
  /** A smaller loan the patient asks for; the difference is paid to the doctor in cash. */
  readonly requestedAmountRial?: bigint | undefined;
  readonly installmentCount: number;
  /** repayment.rounding_unit_rial (ADR-019); see task-3-3 decisions, TODO(decision) ت۹. */
  readonly roundingUnitRial: bigint;
  /** The assumed funding instant (today, in a preview); the basis of every due date. */
  readonly fundedAt: Date;
  /** credit.allow_patient_amount_reduction. */
  readonly allowPatientAmountReduction: boolean;
  /**
   * ADR-050: the proforma's wage lines (W), for a plan financing only them; ignored otherwise.
   * The rest of the proforma (T − W) is the materials, paid to the doctor in cash.
   */
  readonly wageRial?: bigint | undefined;
}

export interface Quote {
  readonly downPaymentRial: bigint;
  /** Proforma total (or, ADR-050, its wage lines) − down payment: the most the plan finances. */
  readonly financeableRial: bigint;
  /** The loan: the financeable amount, or the smaller one the patient asked for. */
  readonly loanRial: bigint;
  /**
   * Paid by the patient to the doctor in cash, outside the ledger: financeable − loan, plus the
   * materials of a wage-only plan (ADR-050).
   */
  readonly cashTopUpRial: bigint;
  /** ADR-050: the materials in `cashTopUpRial` (T − W); 0 for a plan financing everything. */
  readonly materialCashRial: bigint;
  readonly planFeeRial: bigint;
  readonly planFeeTiming: 'at_completion' | 'spread';
  readonly originationFeeRial: bigint;
  /** Origination fee, and the plan fee when it is paid at completion. */
  readonly dueAtCompletionRial: bigint;
  /** What the installments add up to: the loan, plus the plan fee when it is spread. */
  readonly totalObligationRial: bigint;
  readonly installments: readonly ScheduledInstallment[];
  /** Everything the patient pays: down payment, cash top-up, at completion, installments. */
  readonly totalPayableRial: bigint;
  /** ADR-035: the rounding of the plan's shares, or null (whole rials). */
  readonly percentRoundingRial: bigint | null;
}

/**
 * TODO(decision): a share in basis points is rounded down to the whole rial, the same
 * direction as installments (doc 02 §5); doc 02 does not say (task-3-3 decisions).
 */
export function amountOf(rule: CreditAmountRule, base: bigint, roundingRial?: bigint): bigint {
  if (rule.basis === 'fixed') return BigInt(rule.rial);
  const exact = (base * BigInt(rule.bps)) / 10_000n;
  // ADR-035: down to a multiple of the plan's rounding (10 rials: whole tomans).
  return roundingRial ? (exact / roundingRial) * roundingRial : exact;
}

/** ADR-048: what a plan's origination fee is a share of. */
export function originationBase(
  plan: CreditPlan,
  amounts: { proformaTotalRial: bigint; loanRial: bigint },
): bigint {
  return plan.originationFee.basis === 'percent' && plan.originationFee.base === 'proforma'
    ? amounts.proformaTotalRial
    : amounts.loanRial;
}

export interface OriginationReduction {
  /** The fee before any reduction: the case's locked origination_fee_rial. */
  readonly feeRial: bigint;
  /** The waiver applied, in bps of the base: the plan's, or 0 below its cheque count. */
  readonly waiverBps: number;
  /** The officer's discount applied, in bps of the base (at most the plan's). */
  readonly discountBps: number;
  /** What is owed: never below 0, never above the fee. */
  readonly netRial: bigint;
}

/**
 * ADR-048: the origination fee owed after the cheque waiver and the officer's discount. They
 * add up, are taken off the fee's own share and rounded once, with the plan's rounding (ADR-035),
 * so the fee never goes negative and a 3% fee with both is 0 (owner 1405/07/29, answer d).
 * A fixed fee has neither (the plan refuses them). A discount above the plan's maximum is refused.
 */
export function originationReduction(
  plan: CreditPlan,
  input: {
    readonly feeRial: bigint;
    readonly baseRial: bigint;
    readonly checkedBorrowerCheques: number;
    readonly discountBps: number;
  },
): OriginationReduction {
  const rule = plan.originationFee;
  if (rule.basis !== 'percent') {
    if (input.discountBps !== 0) throw new QuoteError('discount_not_in_plan', 'no discount');
    return { feeRial: input.feeRial, waiverBps: 0, discountBps: 0, netRial: input.feeRial };
  }
  if (input.discountBps < 0 || input.discountBps > (plan.originationOfficerDiscountBps ?? 0)) {
    throw new QuoteError('discount_not_in_plan', `plan ${plan.code} allows no such discount`);
  }
  const waiver = plan.originationChequeWaiver;
  const waiverBps =
    waiver !== undefined && input.checkedBorrowerCheques >= waiver.minCheques ? waiver.bps : 0;
  const netBps = Math.max(0, rule.bps - waiverBps - input.discountBps);
  const rounding = plan.percentRoundingRial ? BigInt(plan.percentRoundingRial) : undefined;
  const net = amountOf({ basis: 'percent', bps: netBps }, input.baseRial, rounding);
  // The locked fee bounds it: a rounding or a changed base never owes more than was quoted.
  const netRial = net > input.feeRial ? input.feeRial : net;
  return { feeRial: input.feeRial, waiverBps, discountBps: input.discountBps, netRial };
}

/**
 * The preview of one plan for one proforma (doc 10 §3): pure, no side effect, no ledger
 * entry (doc 10 §1). The installments come only from the phase 1 generator, which
 * refuses (ScheduleError) a total too small for the count.
 */
export function quote(plan: CreditPlan, input: QuoteInput): Quote {
  if (!plan.active) throw new QuoteError('plan_inactive', `plan ${plan.code} is not active`);
  const total = input.proformaTotalRial;
  if (total <= 0n)
    throw new QuoteError('invalid_proforma_total', 'the proforma total must be positive');
  if (!plan.installmentCounts.includes(input.installmentCount)) {
    throw new QuoteError(
      'installment_count_not_in_plan',
      `plan ${plan.code} has no ${String(input.installmentCount)} installments`,
    );
  }

  const rounding = plan.percentRoundingRial ? BigInt(plan.percentRoundingRial) : undefined;
  const downPaymentRial = amountOf(plan.downPayment, total, rounding);
  // ADR-050: a wage-only plan finances the wage lines less the down payment (a share of all).
  const wageOnly = plan.financeableBasis === 'wage';
  let materialCashRial = 0n;
  let basisRial = total;
  if (wageOnly) {
    const wage = input.wageRial;
    if (wage === undefined || wage < 0n || wage > total) {
      throw new QuoteError('wage_required', 'a wage-only plan needs the wage lines, at most all');
    }
    if (downPaymentRial >= wage) {
      throw new QuoteError(
        'down_payment_exceeds_wage',
        'the down payment leaves no wage to finance',
      );
    }
    materialCashRial = total - wage;
    basisRial = wage;
  }
  if (downPaymentRial >= total) {
    throw new QuoteError(
      'down_payment_exceeds_total',
      'the down payment leaves nothing to finance',
    );
  }
  const financeableRial = basisRial - downPaymentRial;

  let loanRial = financeableRial;
  if (input.requestedAmountRial !== undefined && input.requestedAmountRial !== financeableRial) {
    if (!input.allowPatientAmountReduction) {
      throw new QuoteError('amount_reduction_not_allowed', 'the loan cannot be reduced');
    }
    if (input.requestedAmountRial <= 0n || input.requestedAmountRial > financeableRial) {
      throw new QuoteError(
        'invalid_requested_amount',
        'the loan must be positive and at most the financeable amount',
      );
    }
    loanRial = input.requestedAmountRial;
  }
  if (loanRial < BigInt(plan.minAmountRial) || loanRial > BigInt(plan.maxAmountRial)) {
    throw new QuoteError('amount_outside_plan', `the loan is outside plan ${plan.code}`);
  }

  const planFeeRial = amountOf(plan.planFee, loanRial, rounding);
  const originationFeeRial = amountOf(
    plan.originationFee,
    originationBase(plan, { proformaTotalRial: total, loanRial }),
    rounding,
  );
  const spread = plan.planFee.timing === 'spread';
  const totalObligationRial = loanRial + (spread ? planFeeRial : 0n);
  const installments = buildInstallmentSchedule({
    totalRial: totalObligationRial,
    count: input.installmentCount,
    fundedAt: input.fundedAt,
    roundingUnitRial: input.roundingUnitRial,
  });
  const dueAtCompletionRial = originationFeeRial + (spread ? 0n : planFeeRial);
  const cashTopUpRial = financeableRial - loanRial + materialCashRial;

  return {
    downPaymentRial,
    financeableRial,
    loanRial,
    cashTopUpRial,
    materialCashRial,
    planFeeRial,
    planFeeTiming: plan.planFee.timing,
    originationFeeRial,
    dueAtCompletionRial,
    totalObligationRial,
    installments,
    totalPayableRial: downPaymentRial + cashTopUpRial + dueAtCompletionRial + totalObligationRial,
    percentRoundingRial: rounding ?? null,
  };
}
