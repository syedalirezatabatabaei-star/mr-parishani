/**
 * The plan fee waived when a purse is cancelled after funding (task 4-8 [financial], part 7;
 * doc 02 §6 item 2; owner 1405/07/14, پ۱۱ الف and س۱):
 *
 * - each installment's share of the plan fee is the fee divided by the installment count,
 *   rounded down; what is left of the division goes to the FIRST installment (a fixed rule,
 *   never by the amounts);
 * - the borrower keeps paying the share of installments already due on the cancellation day
 *   (Tehran); the share of those not yet due is waived;
 * - an installment with any payment is neither waived nor charged again: its share stays
 *   as it was, due or not;
 * - never more than the fee of the installments not yet due.
 *
 * The amount is then taken off the schedule like a cancelled amount (reduceFromLast: from the
 * last untouched installment back, none below zero); it is capped by what those hold.
 */

export interface FeeWaiverInstallment {
  readonly index: number;
  /** YYYY-MM-DD (Gregorian, Tehran's day). */
  readonly dueOn: string;
  readonly paidRial: bigint;
}

/** Each installment's share of the plan fee, by index 1..count; the remainder on the first. */
export function planFeeShares(feeRial: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError('count must be a positive integer');
  if (feeRial < 0n) throw new RangeError('fee must not be negative');
  const n = BigInt(count);
  const base = feeRial / n;
  const shares = Array.from({ length: count }, () => base);
  shares[0] = base + (feeRial - base * n);
  return shares;
}

/** The fee of the installments not yet due on `today` and never paid at all. */
export function feeToWaive(input: {
  readonly feeRial: bigint;
  readonly count: number;
  readonly installments: readonly FeeWaiverInstallment[];
  /** YYYY-MM-DD: the cancellation's day in Tehran. Due on it counts as due. */
  readonly today: string;
}): bigint {
  if (input.feeRial === 0n) return 0n;
  const shares = planFeeShares(input.feeRial, input.count);
  let waived = 0n;
  for (const i of input.installments) {
    if (i.dueOn <= input.today || i.paidRial !== 0n) continue;
    waived += shares[i.index - 1] ?? 0n;
  }
  return waived;
}

/**
 * ADR-045 (owner 1405/07/27): the unearned part of a plan fee paid in cash at completion,
 * refunded when the purse is cancelled after funding: the shares (as {@link planFeeShares})
 * of the installments not yet due on `today`. Due on `today` counts as earned. Unlike
 * {@link feeToWaive}, an installment paid early is not earned: the cash fee was never in it.
 */
export function unearnedPlanFee(input: {
  readonly feeRial: bigint;
  readonly installments: readonly { readonly index: number; readonly dueOn: string }[];
  /** YYYY-MM-DD: the cancellation's day in Tehran. */
  readonly today: string;
}): bigint {
  if (input.feeRial === 0n || input.installments.length === 0) return 0n;
  const shares = planFeeShares(input.feeRial, input.installments.length);
  let unearned = 0n;
  for (const i of input.installments) {
    if (i.dueOn > input.today) unearned += shares[i.index - 1] ?? 0n;
  }
  return unearned;
}
