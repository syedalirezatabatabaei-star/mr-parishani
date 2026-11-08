import * as z from 'zod';
import { rialAmountSchema } from '../catalog/tariffs.js';
import { creditQuoteViewSchema } from './applications.js';

/**
 * Credit decisions (doc 10 §6; task 3-6). The engine names who decides; a person decides,
 * always with a reason (doc 03 §8-5). No ledger entry (doc 10 §1).
 */

/** Who decides (doc 03 §6), as the scoring rules name them. */
export const DECISION_AUTHORITIES = [
  'expert_second_check',
  'credit_manager',
  'committee',
  'reject_no_override',
] as const;
export type DecisionAuthority = (typeof DECISION_AUTHORITIES)[number];

export const DECISION_OUTCOMES = [
  'approved',
  'conditional',
  'rejected',
  'needs_more_guarantors',
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const DECISION_STATES = ['proposed', 'decided', 'refused', 'withdrawn'] as const;

const code = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const text = (max: number) => z.string().trim().min(3).max(max);

// --- configuration -----------------------------------------------------------------------

/** The editable list of rejection reasons (doc 10 §6). */
export const creditRejectionReasonsSchema = z.object({
  reasons: z
    .array(z.object({ code, label: z.string().trim().min(2).max(120) }))
    .min(1)
    .refine((r) => new Set(r.map((x) => x.code)).size === r.length, {
      message: 'codes must be unique',
    }),
});

/** The committee's units and the roles that make someone a member of each (doc 03 §6). */
export const creditCommitteeUnitsSchema = z
  .object({
    minUnits: z.number().int().min(1).max(10),
    units: z
      .array(
        z.object({
          code,
          label: z.string().trim().min(2).max(120),
          roleCodes: z.array(code).min(1),
        }),
      )
      .min(1),
  })
  .refine((v) => v.minUnits <= v.units.length, { message: 'minUnits exceeds the units' })
  .refine((v) => new Set(v.units.map((u) => u.code)).size === v.units.length, {
    message: 'unit codes must be unique',
  });

const sms = z.string().min(10).max(400);
/** The patient's SMS on a decision: never a reason or a score (doc 10 §6). */
export const creditDecisionSmsTemplatesSchema = z.object({
  approved: sms,
  conditional: sms,
  rejected: sms,
  needsMoreGuarantors: sms,
});

// --- requests ----------------------------------------------------------------------------

const committeeMinutes = z.strictObject({
  minutesNumber: z.string().trim().min(1).max(60),
  meetingAt: z.iso.datetime({ offset: true }),
  attendeeAccountIds: z.array(z.uuid()).min(2).max(20),
});

export const proposeCreditDecisionSchema = z.strictObject({
  outcome: z.enum(DECISION_OUTCOMES),
  reason: text(2000),
  /** Approved or conditional: at most the loan; omitted, the whole loan. */
  approvedAmountRial: rialAmountSchema.optional(),
  /** Conditional: what must be done before funding (phase 4). */
  conditions: z.array(text(300)).min(1).max(10).optional(),
  /** Rejected: a code of credit.rejection_reasons. */
  reasonCode: code.optional(),
  /** Needs more guarantors: what is missing. */
  missing: z.array(text(300)).min(1).max(10).optional(),
  /** An approval the matrix does not allow (doc 03 §6): its own path. */
  outOfMatrix: z.boolean().optional(),
  /** Where the committee decides. */
  committee: committeeMinutes.optional(),
});
export type ProposeCreditDecision = z.input<typeof proposeCreditDecisionSchema>;
export type ProposeCreditDecisionInput = z.output<typeof proposeCreditDecisionSchema>;

export const closeCreditDecisionSchema = z.strictObject({ reason: text(1000) });

export const committeeVoteSchema = z.strictObject({
  unitCode: code,
  vote: z.enum(['approve', 'object']),
  note: z.string().trim().max(1000).optional(),
});

// --- views -------------------------------------------------------------------------------

const instant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const creditDecisionViewSchema = z.object({
  id: z.uuid(),
  outcome: z.enum(DECISION_OUTCOMES),
  status: z.enum(DECISION_STATES),
  authority: z.enum(DECISION_AUTHORITIES),
  outOfMatrix: z.boolean(),
  approvedAmountRial: rial.nullable(),
  quote: creditQuoteViewSchema.nullable(),
  conditions: z.array(z.string()).nullable(),
  missing: z.array(z.string()).nullable(),
  /** Hidden without access.view_decision_reasons (doc 04 §4). */
  decisionReasons: z.object({ reasonCode: z.string().nullable(), reason: z.string() }).optional(),
  /** Hidden without access.view_credit_score (doc 04 §4). */
  creditScore: z.object({ amountLevel: z.string().nullable() }).optional(),
  committee: z
    .object({
      minutesNumber: z.string(),
      meetingAt: instant,
      attendeeAccountIds: z.array(z.uuid()),
      votes: z.array(
        z.object({
          accountId: z.uuid(),
          unitCode: z.string(),
          vote: z.enum(['approve', 'object']),
          at: instant,
        }),
      ),
    })
    .nullable(),
  proposedBy: z.uuid(),
  checkedBy: z.uuid().nullable(),
  closedBy: z.uuid().nullable(),
  createdAt: instant,
  closedAt: instant.nullable(),
});
export type CreditDecisionView = z.infer<typeof creditDecisionViewSchema>;

/** The decision page of an application: what the engine said, and every proposal. */
export const creditDecisionPageSchema = z.object({
  creditApplicationId: z.uuid(),
  status: z.string(),
  authority: z.enum(DECISION_AUTHORITIES).nullable(),
  decision: z.enum(['approved', 'conditional', 'rejected']).nullable(),
  approvedAmountRial: rial.nullable(),
  conditions: z.array(z.string()).nullable(),
  decidedAt: instant.nullable(),
  /** Hidden without access.view_credit_score (doc 04 §4). */
  creditScore: z
    .object({
      borrowerGrade: z.string().nullable(),
      amountLevel: z.string().nullable(),
      guaranteeRequirement: z.string().nullable(),
      sufficiency: z.string().nullable(),
    })
    .optional(),
  decisions: z.array(creditDecisionViewSchema),
  rejectionReasons: z.array(z.object({ code: z.string(), label: z.string() })),
  committeeUnits: z.array(z.object({ code: z.string(), label: z.string() })),
});

/**
 * What an advisor, a doctor or a center sees of a case's credit (doc 10 §6): its state
 * and, for the advisor, the next step. Never a score, an amount or a reason.
 */
export const CREDIT_PUBLIC_STATES = ['none', 'in_review', 'approved', 'rejected'] as const;
export const creditCaseStatusSchema = z.object({
  caseId: z.uuid(),
  state: z.enum(CREDIT_PUBLIC_STATES),
  nextAction: z
    .enum([
      'choose_plan',
      'submit',
      'complete_documents',
      'add_guarantor',
      'wait_for_review',
      'meet_conditions',
      'none',
    ])
    .nullable(),
});
export type CreditCaseStatus = z.infer<typeof creditCaseStatusSchema>;
