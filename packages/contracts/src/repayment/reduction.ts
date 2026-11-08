/**
 * Reducing a schedule by a cancelled amount (task 4-8 [financial]; doc 12 §7; owner
 * 1405/07/13, decision on doc 13 open item 3): «from the last installments back».
 *
 *   (الف) the amount is the cancelled part of the loan, at most what is unused (the wallet
 *        checks; the down payment's part is refunded, never taken off installments);
 *   (ب)  from the last unpaid installment backwards, on to earlier ones while any is left;
 *        no installment ever below zero;
 *   (ج)  an installment with any payment (paid or partly paid, owner پ۶) is never touched;
 *        the result is a new revision, never an update.
 *
 * More than the untouched installments hold is refused whole (owner پ۷).
 */

export interface ReducibleInstallment {
  readonly id: string;
  readonly index: number;
  /** YYYY-MM-DD; the order is by due day, then index. */
  readonly dueOn: string;
  /** Its amount now (the latest revision's, else the original). */
  readonly amountRial: bigint;
  readonly paidRial: bigint;
}

export interface InstallmentChange {
  readonly id: string;
  readonly fromRial: bigint;
  readonly toRial: bigint;
}

export class ReductionError extends Error {
  constructor(
    readonly code: 'amount_must_be_positive' | 'exceeds_unpaid_installments',
    readonly reducibleRial: bigint,
  ) {
    super(code);
    this.name = 'ReductionError';
  }
}

/** The changed installments, last first; the sum of `from − to` is exactly `amountRial`. */
export function reduceFromLast(
  installments: readonly ReducibleInstallment[],
  amountRial: bigint,
): InstallmentChange[] {
  const untouched = installments.filter((i) => i.paidRial === 0n && i.amountRial > 0n);
  const reducible = untouched.reduce((sum, i) => sum + i.amountRial, 0n);
  if (amountRial <= 0n) throw new ReductionError('amount_must_be_positive', reducible);
  if (amountRial > reducible) throw new ReductionError('exceeds_unpaid_installments', reducible);
  const lastFirst = [...untouched].sort((a, b) =>
    a.dueOn === b.dueOn ? b.index - a.index : a.dueOn < b.dueOn ? 1 : -1,
  );
  const changes: InstallmentChange[] = [];
  let left = amountRial;
  for (const i of lastFirst) {
    if (left === 0n) break;
    const cut = i.amountRial < left ? i.amountRial : left;
    changes.push({ id: i.id, fromRial: i.amountRial, toRial: i.amountRial - cut });
    left -= cut;
  }
  return changes;
}
