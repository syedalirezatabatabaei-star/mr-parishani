import * as z from 'zod';

/**
 * Loan contracts (doc 12 §2; task 4-1). The text is a versioned template with fields; a
 * contract fills them once, is printed to an immutable PDF with its SHA-256, and is
 * accepted electronically by the borrower and each guarantor with a one-time code. The
 * lender is Aramesh Sarvat (doc 12 §2); Sepehr Salamati is no party to the loan.
 */

/**
 * The fields a template may use, `{{name}}` in its body. A closed list: an unknown field
 * is refused when the template is proposed. Money is shown in tomans, dates in Jalali.
 */
export const CONTRACT_FIELDS = [
  'contract.number',
  'contract.date',
  'lender.name',
  'borrower.name',
  'borrower.mobile',
  'guarantors.names',
  'plan.title',
  'installments.count',
  'installments.table',
  'loan.amount',
  'downPayment.amount',
  'originationFee.amount',
  'planFee.amount',
  'totalObligation.amount',
  'cancellation.penaltyPercent',
  // ADR-035: how the plan's shares were rounded; empty for a plan that keeps whole rials.
  'amounts.roundingNote',
] as const;
export type ContractField = (typeof CONTRACT_FIELDS)[number];

/** Doc 12 §2: no template is published without the cancellation penalty in its text. */
export const REQUIRED_CONTRACT_FIELDS: readonly ContractField[] = ['cancellation.penaltyPercent'];

const PLACEHOLDER = /\{\{\s*([a-zA-Z.]+)\s*\}\}/g;

/** The fields a template body names, in order of first use. */
export function contractTemplateFields(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? '';
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** What is wrong with a template body: unknown fields, required fields missing. */
export function contractTemplateProblems(body: string): {
  unknown: string[];
  missing: string[];
} {
  const used = contractTemplateFields(body);
  return {
    unknown: used.filter((f) => !(CONTRACT_FIELDS as readonly string[]).includes(f)),
    missing: REQUIRED_CONTRACT_FIELDS.filter((f) => !used.includes(f)),
  };
}

/** Fills a body: each known field from `values`, as given (the caller escapes for HTML). */
export function fillContractTemplate(
  body: string,
  values: Readonly<Record<string, string>>,
): string {
  return body.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

/** The template, a versioned configuration value (`contract.loan_template`). */
export const contractTemplateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  /** `# ` heads a section; a blank line separates paragraphs; `{{field}}` is filled. */
  body: z.string().min(50).max(50_000),
  /** A placeholder text, not for use: printed with «پیش‌نویس — در انتظار تأیید حقوقی». */
  sample: z.boolean(),
  /** The lender (doc 12 §2: Aramesh Sarvat), a legal entity of ADR-007, and its name. */
  lender: z.object({
    entityId: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    name: z.string().trim().min(2).max(200),
  }),
});
export type ContractTemplate = z.infer<typeof contractTemplateSchema>;

// --- API ---------------------------------------------------------------------------

export const CONTRACT_STATUSES = ['generating', 'ready', 'failed', 'accepted'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const generateContractSchema = z.strictObject({ creditApplicationId: z.uuid() });

export const CONTRACT_PARTY_ROLES = ['borrower', 'guarantor'] as const;
export const contractAcceptanceRequestSchema = z.strictObject({
  role: z.enum(CONTRACT_PARTY_ROLES),
});
export const contractAcceptSchema = z.strictObject({
  role: z.enum(CONTRACT_PARTY_ROLES),
  code: z.string().trim().min(4).max(10),
});

const instant = z.iso.datetime({ offset: true });

export const contractViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  number: z.string(),
  entityId: z.string(),
  status: z.enum(CONTRACT_STATUSES),
  templateVersionId: z.uuid(),
  sample: z.boolean(),
  sha256: z.string().nullable(),
  sizeBytes: z.int().nullable(),
  generatedAt: instant.nullable(),
  acceptedAt: instant.nullable(),
  createdAt: instant,
  parties: z.array(
    z.object({
      role: z.enum(CONTRACT_PARTY_ROLES),
      guarantorId: z.uuid().nullable(),
      acceptedAt: instant.nullable(),
      /** Only on a party's own view (`/me/contracts`): whether this party is the viewer. */
      mine: z.boolean().optional(),
    }),
  ),
});
export type ContractView = z.infer<typeof contractViewSchema>;

export const contractLinkSchema = z.object({
  url: z.string().min(1),
  expiresInSeconds: z.int().positive(),
});

export const contractAcceptanceSentSchema = z.object({
  expiresInSeconds: z.int().positive(),
  resendAfterSeconds: z.int().nonnegative(),
});
