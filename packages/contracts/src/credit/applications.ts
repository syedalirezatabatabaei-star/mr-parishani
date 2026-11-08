import * as z from 'zod';
import { rialAmountSchema } from '../catalog/tariffs.js';
import { normalizeDigits } from '../text/digits.js';

/**
 * Credit applications (doc 10 §4; task 3-5): what a patient asks to finance, on a
 * confirmed proforma, with the plan they chose locked to the configuration of that day.
 * No ledger entry is made in phase 3 (doc 10 §1).
 */

export const CREDIT_APPLICATION_STATUSES = [
  'draft',
  'incomplete',
  'ready_for_review',
  'scoring',
  'manual_review',
  'approved',
  'conditional',
  'rejected',
  'expired',
] as const;
export type CreditApplicationStatus = (typeof CREDIT_APPLICATION_STATUSES)[number];

const count = z
  .union([
    z.number(),
    z.string().transform(normalizeDigits).pipe(z.string().regex(/^\d+$/)).transform(Number),
  ])
  .pipe(z.number().int().min(1).max(360));

/** A mobile in any common form; the service normalizes it to 9XXXXXXXXX (rule 24). */
const mobile = z.string().trim().min(10).max(16);

export const createCreditApplicationSchema = z.strictObject({
  proformaId: z.uuid(),
  planCode: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  installmentCount: count,
  /** A smaller loan, only if `credit.allow_patient_amount_reduction` is on. */
  requestedAmountRial: rialAmountSchema.optional(),
  /** Omitted: the patient borrows. Else the borrower's mobile (doc 01: Borrower ≠ Patient). */
  borrowerMobile: mobile.optional(),
});
export type CreateCreditApplication = z.input<typeof createCreditApplicationSchema>;

const rial = z.string().regex(/^\d+$/);
const instant = z.iso.datetime({ offset: true });

export const creditQuoteViewSchema = z.object({
  downPaymentRial: rial,
  financeableRial: rial,
  loanRial: rial,
  cashTopUpRial: rial,
  /** ADR-050: the materials in the cash to the doctor (a wage-only plan); else 0. */
  materialCashRial: rial,
  planFeeRial: rial,
  planFeeTiming: z.enum(['at_completion', 'spread']),
  originationFeeRial: rial,
  dueAtCompletionRial: rial,
  totalObligationRial: rial,
  totalPayableRial: rial,
  installments: z.array(
    z.object({ index: z.int().positive(), dueOn: z.string(), amountRial: rial }),
  ),
  /** ADR-035: the plan's shares rounded to this many rials; absent or null: whole rials. */
  percentRoundingRial: rial.nullable().optional(),
});

/**
 * A draft application's own figures (owner 1405/07/22, M1 §8.7 option ب): the plan, fees and
 * installments recomputed from the configuration versions the application locked when it was
 * created, the ones its decision and contract use. The due days stay approximate: they are
 * counted from the funding day.
 */
export const creditLockedQuoteViewSchema = z.object({
  applicationId: z.uuid(),
  quote: creditQuoteViewSchema,
  dueDatesApproximate: z.literal(true),
});

/** The plans a confirmed proforma can be financed by, each with its preview per count. */
export const proformaPlanOptionsSchema = z.object({
  proformaId: z.uuid(),
  totalRial: rial,
  plans: z.array(
    z.object({
      code: z.string(),
      title: z.string(),
      options: z.array(
        z.object({ installmentCount: z.int().positive(), quote: creditQuoteViewSchema }),
      ),
    }),
  ),
  /**
   * ADR-050 amendment (owner 1405/08/01): plans that fit this case but cannot be offered for this
   * proforma (no count gives a preview, e.g. a wage-only plan whose down payment reaches the
   * wage). Their names only: never a number, a reason or a formula.
   */
  unavailablePlans: z.array(z.object({ code: z.string(), title: z.string() })),
});

export const creditApplicationViewSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  proformaId: z.uuid(),
  status: z.enum(CREDIT_APPLICATION_STATUSES),
  borrowerIsPatient: z.boolean(),
  planCode: z.string(),
  planTitle: z.string(),
  installmentCount: z.int().positive(),
  proformaTotalRial: rial,
  downPaymentRial: rial,
  loanRial: rial,
  cashTopUpRial: rial,
  /** ADR-050: the materials in the cash to the doctor (a wage-only plan); else 0. */
  materialCashRial: rial,
  planFeeRial: rial,
  planFeeTiming: z.enum(['at_completion', 'spread']),
  originationFeeRial: rial,
  totalObligationRial: rial,
  needsMoreGuarantors: z.boolean(),
  /** The group this application finances one treatment with (task 3-7), if any. */
  caseGroupId: z.uuid().nullable(),
  /** At the decision: what is left to pay in cash, and whether it is a small shortfall. */
  approvedCashTopUpRial: rial.nullable(),
  shortfallKind: z.enum(['none', 'small', 'large']).nullable(),
  /** The decision's amount and conditions (task 3-6); never a score or a reason. */
  approvedAmountRial: rial.nullable(),
  conditions: z.array(z.string()).nullable(),
  submittedAt: instant.nullable(),
  slaDueAt: instant.nullable(),
  createdAt: instant,
});
export type CreditApplicationView = z.infer<typeof creditApplicationViewSchema>;

/** The credit queues (doc 10 §8), assigned by the lead module's engine (doc 05 §6). */
export const CREDIT_QUEUES = ['completion', 'credit', 'committee'] as const;
export type CreditQueue = (typeof CREDIT_QUEUES)[number];

export const assignCreditApplicationSchema = z.strictObject({
  queueCode: z.enum(CREDIT_QUEUES),
  accountId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
});

export const creditQueueQuerySchema = z.object({ queueCode: z.enum(CREDIT_QUEUES) });

const pageNumber = (max: number) =>
  z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^[1-9][0-9]{0,3}$/))
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

/** The credit units' list (task 3-8): filtered and paged on the server. */
export const creditApplicationListQuerySchema = z.object({
  status: z.enum(CREDIT_APPLICATION_STATUSES).optional(),
  /** Only those assigned to the caller in this queue. */
  queueCode: z.enum(CREDIT_QUEUES).optional(),
  page: pageNumber(1000).optional(),
  pageSize: pageNumber(50).optional(),
});

export const creditApplicationListSchema = z.object({
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  items: z.array(creditApplicationViewSchema),
});

export const creditAssignmentViewSchema = z.object({
  queueCode: z.enum(CREDIT_QUEUES),
  accountId: z.uuid().nullable(),
  kind: z.enum(['auto', 'manual', 'unassigned']),
  at: z.iso.datetime({ offset: true }),
});

// --- groups (task 3-7, doc 10 §7) --------------------------------------------------------

const groupMember = z.strictObject({
  planCode: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  installmentCount: count,
  /** This member's share of the proforma; its own down payment and fees are on it. */
  shareRial: rialAmountSchema,
  /** Omitted: the patient borrows. */
  borrowerMobile: mobile.optional(),
});

/** Over the cap (doc 10 §7): two borrowers finance one proforma; the shares add up to it. */
export const createCreditGroupSchema = z.strictObject({
  proformaId: z.uuid(),
  members: z.array(groupMember).length(2),
});

/** A large shortfall (doc 10 §7): a new case and loan for what the decision left uncovered. */
export const createShortfallApplicationSchema = z.strictObject({
  planCode: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  installmentCount: count,
  borrowerMobile: mobile.optional(),
});

/** The credit specialist's simple report of a group: each member, decided on its own. */
export const creditGroupViewSchema = z.object({
  caseGroupId: z.uuid(),
  members: z.array(
    z.object({
      id: z.uuid(),
      caseId: z.uuid(),
      proformaId: z.uuid(),
      status: z.enum(CREDIT_APPLICATION_STATUSES),
      borrowerIsPatient: z.boolean(),
      shareRial: rial,
      loanRial: rial,
      approvedAmountRial: rial.nullable(),
      shortfallKind: z.enum(['none', 'small', 'large']).nullable(),
      createdAt: instant,
    }),
  ),
});
export type CreditGroupView = z.infer<typeof creditGroupViewSchema>;
