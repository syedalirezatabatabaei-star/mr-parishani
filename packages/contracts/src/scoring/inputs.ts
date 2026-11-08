import * as z from 'zod';
import { rialAmountSchema } from '../catalog/tariffs.js';
import { jalaliDaySchema } from '../config/holidays.js';

/**
 * The raw data a specialist enters for scoring (doc 03 §8-1, doc 10 §5): numbers and
 * the categories that are categories by nature, never a band chosen by hand where a
 * number exists. Strict: an unknown field is refused, so no medical data (treatment,
 * field, diagnosis, doctor, center) can ever enter a score sheet (doc 03 §8-2; doc 10 §10
 * test 12).
 */

const option = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const rawBorrowerDataSchema = z.strictObject({
  job: option.optional(),
  employmentStartedOn: jalaliDaySchema.optional(),
  /** EXCEL-BUG-5 / TODO(decision): one option until pay and allowed days are defined apart. */
  coverage: option.optional(),
  obligationsRial: rialAmountSchema.optional(),
  newInstallmentRial: rialAmountSchema.optional(),
});

export const rawGuarantorDataSchema = z.strictObject({
  job: option.optional(),
  employmentStartedOn: jalaliDaySchema.optional(),
  averageBalanceRial: rialAmountSchema.optional(),
  installmentRial: rialAmountSchema.optional(),
  debts: option.optional(),
  independence: option.optional(),
});

export const rawScoringDataSchema = z.strictObject({
  borrower: rawBorrowerDataSchema,
  guarantors: z.array(rawGuarantorDataSchema).max(2),
  /**
   * EXCEL-BUG-1: whether the two guarantors share an income source. Recorded, as the
   * workbook asks it (B32), and like the workbook not used in sufficiency.
   */
  guarantorsShareIncome: z.enum(['yes', 'no', 'unknown']).optional(),
});
export type RawScoringDataInput = z.input<typeof rawScoringDataSchema>;
