import * as z from 'zod';
import { addJalaliMonths } from '../jalali/calendar.js';
import { fromJalali, toJalali } from '../jalali/tehran.js';
import { gregorianDayOf } from '../jalali/working-days.js';

/**
 * A doctor's settlement (task 5-1 [financial]; doc 06 §1, §3; doc 14 الف, ب; owner
 * 1405/07/14 and CLAUDE.md §4: every business number is configuration, two people, locked on
 * each record, 0 at first).
 *
 * A service fee is a percent of the service (basis points) or a fixed amount, chosen per
 * level (doctor, center, treatment field, global). A percent is rounded DOWN to the rial,
 * in the doctor's favor (task 5-1's ADR; apart from ADR-035's plan rounding).
 */

const rial = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

export const serviceFeeRateSchema = z.discriminatedUnion('basis', [
  z.strictObject({ basis: z.literal('percent'), bps: z.int().min(0).max(10_000) }),
  z.strictObject({ basis: z.literal('fixed'), rial }),
]);
export type ServiceFeeRate = z.infer<typeof serviceFeeRateSchema>;

/** The fee of one service: never negative; a percent rounded down to the rial. */
export function serviceFee(amountRial: bigint, rate: ServiceFeeRate): bigint {
  if (amountRial < 0n) throw new RangeError('amount must not be negative');
  if (rate.basis === 'fixed') return BigInt(rate.rial);
  return (amountRial * BigInt(rate.bps)) / 10_000n;
}

/** What a rate is stored as on a record: its basis and its value (bps, or rials as text). */
export function rateValue(rate: ServiceFeeRate): string {
  return rate.basis === 'percent' ? String(rate.bps) : rate.rial;
}

/**
 * When a doctor's payable is due (doc 14 ب): the Tehran day the service became final plus
 * the contract's cycle in Jalali months, with the installments' last-day rule (31 → 30 →
 * 29 Esfand); due from that day's first moment in Tehran. Stored in UTC (owner, 5-1).
 */
export function payableDue(
  finalizedAt: Date,
  cycleMonths: number,
): { readonly dueOn: string; readonly dueAt: Date } {
  if (!Number.isInteger(cycleMonths) || cycleMonths < 1) {
    throw new RangeError('cycle months must be a positive integer');
  }
  const day = addJalaliMonths(toJalali(finalizedAt), cycleMonths);
  return { dueOn: gregorianDayOf(day), dueAt: fromJalali(day, { hour: 0 }) };
}

/**
 * ADR-046 (owner 1405/07/27): a doctor's or center's contract term. Both null: no term
 * recorded (nothing ends). The term runs from `startsOn` (a Tehran day, YYYY-MM-DD) for 3, 6
 * or 12 Jalali months; from its end day on, no new service is recorded.
 */
export const providerContractSchema = z
  .object({
    startsOn: z.iso.date().nullable(),
    months: z.union([z.literal(3), z.literal(6), z.literal(12)]).nullable(),
  })
  .refine((v) => (v.startsOn === null) === (v.months === null), {
    message: 'startsOn and months are set together or not at all',
  });
export type ProviderContract = z.infer<typeof providerContractSchema>;

/** Owner 1405/07/27: a term as a registration form gives it, both fields required. */
export const providerContractTermSchema = z.object({
  startsOn: z.iso.date(),
  months: z.union([z.literal(3), z.literal(6), z.literal(12)]),
});

/**
 * The day the term ends (YYYY-MM-DD, Tehran), the first day it no longer covers: `months`
 * Jalali months after `startsOn`, the last day of a shorter month as {@link payableDue} does.
 * Null without a term.
 */
export function providerContractEndsOn(term: ProviderContract): string | null {
  if (term.startsOn === null || term.months === null) return null;
  // Noon UTC is the same Tehran day, whatever the offset.
  const start = toJalali(new Date(`${term.startsOn}T12:00:00Z`));
  return gregorianDayOf(addJalaliMonths(start, term.months));
}

/** Whether `today` (YYYY-MM-DD, Tehran) is past the term: on its end day it has ended. */
export function providerContractEnded(term: ProviderContract, today: string): boolean {
  const ends = providerContractEndsOn(term);
  return ends !== null && today >= ends;
}
