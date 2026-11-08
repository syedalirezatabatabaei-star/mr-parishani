import * as z from 'zod';
import { addJalaliMonths } from '../jalali/calendar.js';
import { fromJalali, toJalali } from '../jalali/tehran.js';

/**
 * A doctor's monthly statement (task 5-4 [financial]; doc 06 §2; doc 14 ب, پ):
 *
 *   payable = gross − credit fees − cash fees − carried in − other deductions
 *
 * Negative: nothing is paid; carried_out = −payable goes to the next statement as its
 * carried_in. The fee offset in the ledger (Dr doctor.payable / Cr doctor.fee_receivable) is
 * what the services can cover: min(gross, all the deductions); what is left of the deductions
 * stays in doctor.fee_receivable, and is exactly carried_out.
 */

export interface StatementInput {
  /** Each credit service's payable in the period (rials, above 0). */
  readonly payables: readonly bigint[];
  readonly creditFees: readonly bigint[];
  readonly cashFees: readonly bigint[];
  readonly carriedIn: bigint;
  readonly otherDeductions: bigint;
}

export interface StatementTotals {
  readonly grossRial: bigint;
  readonly creditFeesRial: bigint;
  readonly cashFeesRial: bigint;
  readonly carriedInRial: bigint;
  readonly otherDeductionsRial: bigint;
  /** Signed: negative when the deductions are more than the services. */
  readonly payableRial: bigint;
  readonly carriedOutRial: bigint;
  /** Posted Dr doctor.payable / Cr doctor.fee_receivable. */
  readonly offsetRial: bigint;
}

const sum = (xs: readonly bigint[]) => xs.reduce((s, x) => s + x, 0n);

export function buildStatement(input: StatementInput): StatementTotals {
  const all = [
    ...input.payables,
    ...input.creditFees,
    ...input.cashFees,
    input.carriedIn,
    input.otherDeductions,
  ];
  if (all.some((x) => x < 0n)) throw new RangeError('no amount of a statement is negative');
  const gross = sum(input.payables);
  const creditFees = sum(input.creditFees);
  const cashFees = sum(input.cashFees);
  const deductions = creditFees + cashFees + input.carriedIn + input.otherDeductions;
  const payable = gross - deductions;
  return {
    grossRial: gross,
    creditFeesRial: creditFees,
    cashFeesRial: cashFees,
    carriedInRial: input.carriedIn,
    otherDeductionsRial: input.otherDeductions,
    payableRial: payable,
    carriedOutRial: payable < 0n ? -payable : 0n,
    offsetRial: gross < deductions ? gross : deductions,
  };
}

/**
 * Splits an amount over buckets in their order, none above its own size: the offset's lines
 * per doctor node (its payables on one side, its fees owed on the other).
 */
export function allocate(amount: bigint, buckets: readonly bigint[]): bigint[] {
  let left = amount;
  const out = buckets.map((b) => {
    const take = b < left ? b : left;
    left -= take;
    return take;
  });
  if (left !== 0n) throw new RangeError('more than the buckets hold');
  return out;
}

export const STATEMENT_STATUSES = ['draft', 'reviewed', 'approved', 'paid', 'cancelled'] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

/**
 * A statement's lines: its items (a payable, a credit or cash fee), and per doctor node what
 * was carried in, what the offset took on each side, and what is carried out.
 */
export const STATEMENT_LINE_TYPES = [
  'credit_service',
  'credit_fee',
  'cash_fee',
  'carried_in',
  'other_deduction',
  'offset_payable',
  'offset_fee',
  'carried_out',
] as const;
export type StatementLineType = (typeof STATEMENT_LINE_TYPES)[number];

/** A Jalali month as UTC instants: [its first Tehran midnight, the next month's). */
export function statementPeriod(year: number, month: number): { start: Date; end: Date } {
  const first = { year, month, day: 1 };
  return { start: fromJalali(first), end: fromJalali(addJalaliMonths(first, 1)) };
}

/** The Jalali month before the one Tehran is in at this instant: the one to draft now. */
export function lastClosedPeriod(now: Date): { year: number; month: number } {
  const today = toJalali(now);
  const { year, month } = addJalaliMonths({ year: today.year, month: today.month, day: 1 }, -1);
  return { year, month };
}

export const statementQuerySchema = z.object({
  doctorId: z.uuid().optional(),
  year: z.coerce.number().int().min(1400).max(1500).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  status: z.enum(STATEMENT_STATUSES).optional(),
});

export const cancelStatementSchema = z.strictObject({
  reason: z.string().trim().min(3).max(1000),
});

const instant = z.iso.datetime({ offset: true });
const rial = z.string();

export const statementViewSchema = z.object({
  id: z.uuid(),
  doctorId: z.uuid(),
  periodYear: z.int(),
  periodMonth: z.int(),
  status: z.enum(STATEMENT_STATUSES),
  grossCreditServicesRial: rial,
  creditFeesRial: rial,
  cashFeesRial: rial,
  carriedInRial: rial,
  otherDeductionsRial: rial,
  payableRial: rial,
  carriedOutRial: rial,
  offsetRial: rial,
  generatedAt: instant,
  /** Asked to be cancelled, and by whom (never decided by the same person). */
  cancelRequestedAt: instant.nullable(),
  cancelRequestedByMe: z.boolean(),
  /** Reviewed, and approved by someone else (task 5-5). */
  reviewedAt: instant.nullable(),
  reviewedByMe: z.boolean(),
  approvedAt: instant.nullable(),
  lines: z.array(
    z.object({
      lineType: z.enum(STATEMENT_LINE_TYPES),
      refType: z.string(),
      refId: z.uuid(),
      amountRial: rial,
    }),
  ),
});
export type StatementView = z.infer<typeof statementViewSchema>;
