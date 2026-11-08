/**
 * An installment's state (task 6-1 [financial]; doc 15 §3; ADR-019): derived, never stored,
 * from its amount, what was allocated to it and the Tehran day. Phase 1's statusOf with the
 * grace days of its schedule: due on its day, overdue once the grace days have passed.
 * Days past due count from the due day itself, grace or not (doc 15 §3).
 */

export type InstallmentState =
  | 'scheduled'
  | 'due'
  | 'overdue'
  | 'partially_paid'
  | 'paid'
  /** Taken to zero by a schedule revision (task 4-8). */
  | 'cancelled';

const DAY_MS = 86_400_000;

/** Calendar days from one YYYY-MM-DD to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const at = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) throw new RangeError(`not a day: ${d}`);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  return Math.round((at(to) - at(from)) / DAY_MS);
}

export function installmentState(
  dueOn: string,
  amountRial: bigint,
  paidRial: bigint,
  today: string,
  graceDays: number,
): { status: InstallmentState; daysPastDue: number } {
  if (!Number.isInteger(graceDays) || graceDays < 0) throw new RangeError('grace days ≥ 0');
  if (amountRial === 0n && paidRial === 0n) return { status: 'cancelled', daysPastDue: 0 };
  if (paidRial >= amountRial) return { status: 'paid', daysPastDue: 0 };
  const late = daysBetween(dueOn, today);
  const daysPastDue = late > 0 ? late : 0;
  if (daysPastDue > graceDays) return { status: 'overdue', daysPastDue };
  if (paidRial > 0n) return { status: 'partially_paid', daysPastDue };
  if (late >= 0) return { status: 'due', daysPastDue };
  return { status: 'scheduled', daysPastDue };
}
