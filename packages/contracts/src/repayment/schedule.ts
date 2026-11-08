import { addJalaliMonths, compareJalali, type JalaliDate } from '../jalali/calendar.js';
import { toJalali } from '../jalali/tehran.js';
import { gregorianDayOf } from '../jalali/working-days.js';

/**
 * Installment schedules (doc 02 §5, task 1-3). Pure: the same inputs always give the
 * same schedule, so it can be recomputed and checked anywhere.
 */

export interface ScheduleInput {
  /** Total obligation in rials: principal plus the plan fee (doc 02 §3). */
  readonly totalRial: bigint;
  readonly count: number;
  /** When the purse was charged: the basis of every due date (doc 02 §5). */
  readonly fundedAt: Date;
  /** Installments are rounded down to this unit (configuration). */
  readonly roundingUnitRial: bigint;
  /**
   * When due dates move off non-working days (task 2-1): maps a nominal due day to the
   * day it is actually due, e.g. `(d) => nextWorkingDay(d, null, calendar)`. Absent: due
   * days are the nominal ones. Only dates move; amounts never do.
   */
  readonly dueDay?: (nominal: JalaliDate) => JalaliDate;
}

export interface ScheduledInstallment {
  /** 1-based. */
  readonly index: number;
  /** The due day in the Jalali calendar (Tehran). */
  readonly dueJalali: JalaliDate;
  /** The same day in the Gregorian calendar, YYYY-MM-DD, as stored (`date`). */
  readonly dueOn: string;
  readonly amountRial: bigint;
}

/** A schedule that cannot be built; `code` is stable, for API errors. */
export class ScheduleError extends Error {
  override readonly name = 'ScheduleError';
  constructor(
    readonly code:
      | 'amount_must_be_bigint_rial'
      | 'invalid_installment_count'
      | 'invalid_rounding_unit'
      | 'total_too_small_for_count'
      | 'invalid_funded_at'
      | 'invalid_due_day',
    message: string,
  ) {
    super(message);
  }
}

/** A sanity bound, not a business rule: 30 years of monthly installments. */
export const MAX_INSTALLMENTS = 360;

/** YYYY-MM-DD of a Jalali day, in the Gregorian calendar. */
export const gregorianDay = gregorianDayOf;

/**
 * Splits the total into `count` installments (doc 02 §5):
 *
 *   base = floor(total / count / unit) × unit   — always down
 *   installment 1 = base + (total − base × count)
 *   installments 2..count = base
 *
 * so the installments always sum to the total. Installment k falls due k Jalali months
 * after the funding day in Tehran, each computed from the funding day itself (never from
 * the previous installment): the 31st stays the 31st in every 31-day month and becomes
 * the last day of shorter ones (Mehr 30; Esfand 29, or 30 in a leap year).
 *
 * Hard rule (task 1-3 decision): a total too small to give every installment at least one
 * rounding unit is refused; a schedule never contains a zero installment.
 */
export function buildInstallmentSchedule(input: ScheduleInput): ScheduledInstallment[] {
  const { totalRial, count, fundedAt, roundingUnitRial } = input;
  if (typeof totalRial !== 'bigint' || typeof roundingUnitRial !== 'bigint') {
    throw new ScheduleError('amount_must_be_bigint_rial', 'amounts are bigint rials');
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_INSTALLMENTS) {
    throw new ScheduleError(
      'invalid_installment_count',
      `installment count must be 1..${String(MAX_INSTALLMENTS)}`,
    );
  }
  if (roundingUnitRial <= 0n) {
    throw new ScheduleError('invalid_rounding_unit', 'rounding unit must be positive');
  }
  const n = BigInt(count);
  if (totalRial < n * roundingUnitRial) {
    throw new ScheduleError(
      'total_too_small_for_count',
      `total ${totalRial.toString()} rials cannot give ${String(count)} installments of at least ${roundingUnitRial.toString()} rials`,
    );
  }
  if (!(fundedAt instanceof Date) || Number.isNaN(fundedAt.getTime())) {
    throw new ScheduleError('invalid_funded_at', 'funded_at must be a valid instant');
  }

  const base = (totalRial / (n * roundingUnitRial)) * roundingUnitRial;
  const remainder = totalRial - base * n;
  const funded = toJalali(fundedAt);
  let previous: JalaliDate | null = null;
  return Array.from({ length: count }, (_, i) => {
    const nominal = addJalaliMonths(funded, i + 1);
    const dueJalali = input.dueDay ? input.dueDay(nominal) : nominal;
    // A due day only ever moves forward, and never onto or past the next one.
    if (
      compareJalali(dueJalali, nominal) < 0 ||
      (previous !== null && compareJalali(dueJalali, previous) <= 0)
    ) {
      throw new ScheduleError(
        'invalid_due_day',
        `installment ${String(i + 1)} due day out of order`,
      );
    }
    previous = dueJalali;
    return {
      index: i + 1,
      dueJalali,
      dueOn: gregorianDay(dueJalali),
      amountRial: i === 0 ? base + remainder : base,
    };
  });
}

/**
 * Read only (owner 1405/07/24): installment `index`'s nominal due day, Gregorian YYYY-MM-DD,
 * `index` Jalali months after the funding day in Tehran: what {@link buildInstallmentSchedule}
 * gives before a `dueDay` moves it. Shown beside a due day that moved to a working day; never
 * used to compute, store or change one.
 */
export function nominalDueOn(fundedAt: Date, index: number): string {
  return gregorianDay(addJalaliMonths(toJalali(fundedAt), index));
}
