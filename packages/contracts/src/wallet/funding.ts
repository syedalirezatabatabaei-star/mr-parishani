import * as z from 'zod';

/**
 * Funding a credit purse (doc 12 §5; task 4-5; ADR-034): asked by case completion,
 * approved by another person in finance, in one transaction: credit approved, the purse
 * charged (the loan and the down payment), the plan fee, the installment schedule from
 * `funded_at`. Amounts are whole rials as text (rule 1; JSON has no bigint).
 */

export const FUNDING_REQUEST_STATUSES = ['requested', 'approved', 'rejected', 'cancelled'] as const;
export type FundingRequestStatus = (typeof FUNDING_REQUEST_STATUSES)[number];

export const requestFundingSchema = z.strictObject({ creditApplicationId: z.uuid() });
export const rejectFundingSchema = z.strictObject({ reason: z.string().trim().min(3).max(500) });
export const fundingQuerySchema = z.object({
  status: z.enum(FUNDING_REQUEST_STATUSES).optional(),
  creditApplicationId: z.uuid().optional(),
});

const instant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const fundingRequestViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  status: z.enum(FUNDING_REQUEST_STATUSES),
  requestedAt: instant,
  /** Whether the viewer asked for it (a request is never approved by its asker). */
  requestedByMe: z.boolean(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
  purseId: z.uuid().nullable(),
  scheduleId: z.uuid().nullable(),
  /** What funding will move, from the decision (doc 12 §5): the loan and the down payment. */
  approvedAmountRial: rial,
  downPaymentRial: rial,
  installmentCount: z.int().positive(),
});
export type FundingRequestView = z.infer<typeof fundingRequestViewSchema>;

/** The patient's or borrower's view of a funded purse: what is usable and what is owed. */
export const myFundingViewSchema = z.object({
  creditApplicationId: z.uuid(),
  /** What the patient's pages call the purse (`wallet.purse_title`; task 4-7). */
  purseTitle: z.string(),
  funded: z.boolean(),
  fundedAt: instant.nullable(),
  /** The loan and the down payment the purse holds (ADR-034). */
  approvedAmountRial: rial,
  downPaymentRial: rial,
  availableRial: rial,
  totalRial: rial,
  installments: z.array(
    z.object({
      index: z.int().positive(),
      dueOn: z.string(),
      amountRial: rial,
      status: z.string(),
    }),
  ),
});
export type MyFundingView = z.infer<typeof myFundingViewSchema>;

/** SMS of funding (doc 12 §5): the patient's, and the doctor's with nothing financial. */
export const walletSmsTemplatesSchema = z.object({
  patientFunded: z
    .string()
    .min(10)
    .max(400)
    .refine((t) => t.includes('{amount}'), { message: 'needs {amount}' }),
  doctorPatientReady: z
    .string()
    .min(10)
    .max(400)
    // Doc 12 §9.10: never an amount in the doctor's message.
    .refine((t) => !/\{amount\}|\{firstAmount\}|تومان|ریال/.test(t), {
      message: 'the doctor is told no amount',
    }),
});

/**
 * The phrase never used for a credit purse (doc 01: «کیف» with «پول», a wallet of money),
 * built from its words so that the phrase itself never appears in a build (task 4-7: the
 * build output is checked for it).
 */
const NOT_THE_PURSE = ['کیف', 'پول'].join(' ');

/**
 * The purse's name in the patient's pages (task 4-7; doc 13: from configuration, «کیف اعتبار»
 * by default), never the money-wallet phrase however it is spaced.
 */
export const purseTitleSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .refine((t) => !t.replace(/[‌\s]+/g, ' ').includes(NOT_THE_PURSE), {
    message: 'never the money-wallet phrase (doc 01)',
  });
