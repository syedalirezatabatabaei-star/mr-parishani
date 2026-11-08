import * as z from 'zod';
import { rawBorrowerDataSchema, rawGuarantorDataSchema } from '../scoring/inputs.js';
import { normalizeDigits } from '../text/digits.js';

/**
 * Consent, score sheets and guarantors of a credit application (doc 10 §4–§5; task 3-5
 * part B). Raw data only, through the strict schemas of task 3-2: no medical field can
 * enter a score sheet (doc 10 §10 test 12).
 */

export const CONSENT_ROLES = ['borrower', 'guarantor'] as const;
export type ConsentRole = (typeof CONSENT_ROLES)[number];

export const GUARANTOR_STATUSES = ['invited', 'consented', 'scored', 'withdrawn'] as const;

export const requestConsentSchema = z.strictObject({ role: z.enum(CONSENT_ROLES) });
export const giveConsentSchema = z.strictObject({
  role: z.enum(CONSENT_ROLES),
  code: z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^\d{6}$/)),
});

/** A guarantor introduced by mobile (any common form; normalized by the service). */
export const inviteGuarantorSchema = z.strictObject({ mobile: z.string().trim().min(10).max(16) });

export const scoreSheetInputSchema = z.discriminatedUnion('subject', [
  z.strictObject({ subject: z.literal('borrower'), raw: rawBorrowerDataSchema }),
  z.strictObject({
    subject: z.literal('guarantor'),
    guarantorId: z.uuid(),
    raw: rawGuarantorDataSchema,
  }),
]);

const instant = z.iso.datetime({ offset: true });

export const consentSentSchema = z.object({
  expiresInSeconds: z.int().positive(),
  resendAfterSeconds: z.int().nonnegative(),
});
export const consentTextSchema = z.object({ text: z.string(), versionId: z.uuid() });
export const consentGivenSchema = z.object({ role: z.enum(CONSENT_ROLES), givenAt: instant });

export const guarantorInvitedSchema = z.object({
  id: z.uuid(),
  status: z.enum(GUARANTOR_STATUSES),
  invitedAt: instant,
});

export const scoreSheetViewSchema = z.object({
  id: z.uuid(),
  subject: z.enum(CONSENT_ROLES),
  guarantorId: z.uuid().nullable(),
  rulesetVersionId: z.uuid(),
  /** The raw data as entered (doc 03 §8-1), shown beside the band the engine chose. */
  rawInputs: z.record(z.string(), z.unknown()),
  answers: z.record(z.string(), z.string()),
  criteriaScores: z.record(z.string(), z.number().nullable()),
  total: z.int().nullable(),
  grade: z.string().nullable(),
  gradeLabel: z.string().nullable(),
  stop: z.boolean().nullable(),
  createdAt: instant,
});

const scoringCriterionViewSchema = z.object({
  code: z.string(),
  label: z.string(),
  options: z.array(z.object({ code: z.string(), label: z.string(), score: z.number() })),
});

/** For the credit units with access.view_credit_score (doc 10 §6). */
export const applicationScoringSchema = z.object({
  creditApplicationId: z.uuid(),
  rulesetVersionId: z.uuid().nullable(),
  borrowerGrade: z.string().nullable(),
  amountLevel: z.string().nullable(),
  sheets: z.array(scoreSheetViewSchema),
  guarantors: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(GUARANTOR_STATUSES),
      invitedAt: instant,
      consentAt: instant.nullable(),
      grade: z.string().nullable(),
      weight: z.int().nullable(),
    }),
  ),
  /** The engine's proposal on the latest sheets; the decision is a person's (doc 03 §8-5). */
  outcome: z
    .object({
      requirement: z.string().nullable(),
      sufficiency: z.object({ outcome: z.string(), label: z.string() }),
      authority: z.object({ authority: z.string(), label: z.string() }).nullable(),
    })
    .nullable(),
  /** The rules' criteria and options, to enter raw data and name each score (task 3-8). */
  criteria: z.object({
    borrower: z.array(scoringCriterionViewSchema),
    guarantor: z.array(scoringCriterionViewSchema),
  }),
});

/** What a guarantor sees: only their own commitment (doc 10 §5; doc 03 §8-7). */
export const myGuaranteeSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  commitmentRial: z.string().regex(/^\d+$/),
  status: z.enum(GUARANTOR_STATUSES),
  consentGiven: z.boolean(),
  invitedAt: instant,
});
