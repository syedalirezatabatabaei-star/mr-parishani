import * as z from 'zod';
import { normalizeDigits } from '../text/digits.js';
import { normalizeLegalId } from '../text/legal-id.js';
import { normalizeNationalId } from '../text/national-id.js';
import { normalizePersianText } from '../text/persian.js';
import { normalizeSheba } from '../text/sheba.js';
import { providerContractTermSchema } from '../settlement/fees.js';

/**
 * Centers and branches (task 2-2, doc 08 §2–3). Identifiers and Sheba numbers are checked
 * by their algorithms here, before anything is stored; the API stores them only encrypted.
 */

export const CENTER_STATUSES = [
  'draft',
  'under_review',
  'needs_fix',
  'active',
  'suspended',
  'terminated',
] as const;
export type CenterStatus = (typeof CENTER_STATUSES)[number];

export const CENTER_PERSON_TYPES = ['natural', 'legal'] as const;
export type CenterPersonType = (typeof CENTER_PERSON_TYPES)[number];

export const CENTER_DOCUMENT_STATUSES = ['received', 'verified', 'incomplete'] as const;
export type CenterDocumentStatus = (typeof CENTER_DOCUMENT_STATUSES)[number];

export const PARKING_OPTIONS = ['available', 'limited', 'none'] as const;

const code = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 500);

/** A landline or mobile number, 0 then 9–10 digits, any digit script. */
const phone = z
  .string()
  .transform((v) => normalizeDigits(v).replace(/[\s\-()]/g, ''))
  .pipe(z.string().regex(/^0\d{9,10}$/));

/** Degrees in, millionths of a degree out: coordinates are stored as integers. */
const coordinate = (limit: number) =>
  z
    .number()
    .min(-limit)
    .max(limit)
    .transform((deg) => Math.round(deg * 1_000_000));
const location = z.object({ latitude: coordinate(90), longitude: coordinate(180) });

export const shebaSchema = z.string().transform((v, ctx) => {
  const sheba = normalizeSheba(v);
  if (sheba === null) {
    ctx.addIssue({ code: 'custom', message: 'invalid Sheba' });
    return z.NEVER;
  }
  return sheba;
});

/** Normalizes and checks the identifier for the person type: national ID or legal-entity ID. */
export function normalizeCenterIdentifier(type: CenterPersonType, value: string): string | null {
  return type === 'natural' ? normalizeNationalId(value) : normalizeLegalId(value);
}

const centerDetails = {
  name: text(2, 200),
  address: text(5, 500).optional(),
  location: location.optional(),
  phone: phone.optional(),
  licenseNumber: text(1, 50).optional(),
  treatmentFieldCodes: z
    .array(code)
    .max(30)
    .refine((codes) => new Set(codes).size === codes.length, { message: 'repeated field' })
    .optional(),
};

const bankAccount = {
  sheba: shebaSchema.optional(),
  accountHolderName: text(2, 200).optional(),
};

const bothOrNeither = (v: { sheba?: string | undefined; accountHolderName?: string | undefined }) =>
  (v.sheba === undefined) === (v.accountHolderName === undefined);

export const createCenterSchema = z
  .object({
    personType: z.enum(CENTER_PERSON_TYPES),
    /** National ID for a natural person, legal-entity ID for a legal one. */
    identifier: z.string(),
    cityCode: code,
    ...centerDetails,
    ...bankAccount,
    /** The default branch's name; the center's own by default. */
    defaultBranchName: text(2, 200).optional(),
    /**
     * Owner 1405/07/27 (ADR-046): the center's contract term. Required by the registration
     * form ({@link registerCenterSchema}); a bulk import row may have none (the launch check
     * then fails until one is set).
     */
    contractTerm: providerContractTermSchema.optional(),
  })
  .refine(bothOrNeither, { message: 'sheba and account holder go together' })
  .transform((v, ctx) => {
    const identifier = normalizeCenterIdentifier(v.personType, v.identifier);
    if (identifier === null) {
      ctx.addIssue({ code: 'custom', path: ['identifier'], message: 'invalid identifier' });
      return z.NEVER;
    }
    return { ...v, identifier };
  });
export type CreateCenter = z.input<typeof createCenterSchema>;

/** The registration form (owner 1405/07/27): never saved without the contract term. */
export const registerCenterSchema = createCenterSchema.and(
  z.object({ contractTerm: providerContractTermSchema }),
);

/**
 * Editing a center. What may change depends on its status (checked by the service):
 * identity and bank account only before the first activation; afterwards a new bank
 * account is a two-person request.
 */
export const updateCenterSchema = z
  .object({
    personType: z.enum(CENTER_PERSON_TYPES).optional(),
    identifier: z.string().optional(),
    ...centerDetails,
    name: centerDetails.name.optional(),
    ...bankAccount,
    reason,
  })
  .refine(bothOrNeither, { message: 'sheba and account holder go together' })
  .refine((v) => (v.personType === undefined) === (v.identifier === undefined), {
    message: 'person type and identifier go together',
  })
  .transform((v, ctx) => {
    if (v.personType === undefined || v.identifier === undefined) return v;
    const identifier = normalizeCenterIdentifier(v.personType, v.identifier);
    if (identifier === null) {
      ctx.addIssue({ code: 'custom', path: ['identifier'], message: 'invalid identifier' });
      return z.NEVER;
    }
    return { ...v, identifier };
  });
export type UpdateCenter = z.input<typeof updateCenterSchema>;

const branchDetails = {
  address: text(5, 500).optional(),
  location: location.optional(),
  phone: phone.optional(),
  // How to get there, shown to patients (doc 08 §3).
  parking: z.enum(PARKING_OPTIONS).optional(),
  nearestMetro: text(2, 200).optional(),
  nearestBrt: text(2, 200).optional(),
  routeNote: text(2, 1000).optional(),
};

export const createBranchSchema = z.object({ name: text(2, 200), ...branchDetails, reason });
export type CreateBranch = z.input<typeof createBranchSchema>;

export const updateBranchSchema = z.object({
  name: text(2, 200).optional(),
  ...branchDetails,
  reason,
});
export type UpdateBranch = z.input<typeof updateBranchSchema>;

export const setDocumentStatusSchema = z.object({
  status: z.enum(CENTER_DOCUMENT_STATUSES),
  note: text(2, 500).optional(),
});
export type SetDocumentStatus = z.input<typeof setDocumentStatusSchema>;

/** Why a status changes: every transition is recorded with its reason. */
export const centerTransitionSchema = z.object({ reason });

export const proposeBankAccountSchema = z.object({
  sheba: shebaSchema,
  accountHolderName: text(2, 200),
  reason,
});
export type ProposeBankAccount = z.input<typeof proposeBankAccountSchema>;

export const decideCenterRequestSchema = z.object({ note: text(2, 500).optional() });

// --- answers (task 2-11: the center panel and the internal panel's review queue) --------

const isoInstant = z.iso.datetime({ offset: true });
const geo = z.object({ latitude: z.number(), longitude: z.number() }).nullable();

/** A center; only the last four digits of its identifier and Sheba (rule 27). */
export const centerViewSchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  personType: z.enum(CENTER_PERSON_TYPES),
  name: z.string(),
  cityCode: z.string(),
  address: z.string().nullable(),
  location: geo,
  phone: z.string().nullable(),
  licenseNumber: z.string().nullable(),
  identifierLast4: z.string(),
  shebaLast4: z.string().nullable(),
  accountHolderName: z.string().nullable(),
  status: z.enum(CENTER_STATUSES),
  firstActivatedAt: isoInstant.nullable(),
});
export const centerListSchema = z.array(centerViewSchema);
export type CenterViewBody = z.infer<typeof centerViewSchema>;

export const branchViewSchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  centerId: z.uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  address: z.string().nullable(),
  location: geo,
  phone: z.string().nullable(),
  parking: z.enum(PARKING_OPTIONS).nullable(),
  nearestMetro: z.string().nullable(),
  nearestBrt: z.string().nullable(),
  routeNote: z.string().nullable(),
});
export type BranchViewBody = z.infer<typeof branchViewSchema>;

/** A request on a center that a second person decides (activation, Sheba change). */
export const centerRequestViewSchema = z.object({
  id: z.uuid(),
  centerId: z.uuid(),
  kind: z.enum(['activation', 'reactivation', 'bank_account']),
  status: z.enum(['proposed', 'approved', 'rejected', 'withdrawn']),
  shebaLast4: z.string().nullable(),
  accountHolderName: z.string().nullable(),
  reason: z.string(),
  proposedBy: z.uuid(),
  decidedBy: z.uuid().nullable(),
  decidedAt: isoInstant.nullable(),
  decisionNote: z.string().nullable(),
});
export const centerRequestListSchema = z.array(centerRequestViewSchema);
export type CenterRequestBody = z.infer<typeof centerRequestViewSchema>;

/** `GET /catalog/centers/:id`: the branches the caller covers, the checklist, the requests. */
export const centerDetailSchema = centerViewSchema.extend({
  branches: z.array(branchViewSchema),
  treatmentFieldCodes: z.array(z.string()),
  documents: z.array(
    z.object({
      code: z.string(),
      title: z.string(),
      status: z.enum(CENTER_DOCUMENT_STATUSES).nullable(),
      note: z.string().nullable(),
    }),
  ),
  requests: z.array(centerRequestViewSchema),
});
export type CenterDetail = z.infer<typeof centerDetailSchema>;

/** `PUT /catalog/centers/:id/documents/:code`: one checklist document's new status. */
export const centerDocumentStatusViewSchema = z.object({
  code: z.string(),
  status: z.enum(CENTER_DOCUMENT_STATUSES),
  note: z.string().nullable(),
});

/**
 * `GET /catalog/centers/:id/bank-account`: the whole Sheba, for those holding
 * `catalog.view_bank_account` only, and every read audited.
 */
export const centerBankAccountViewSchema = z.object({
  sheba: z.string().nullable(),
  accountHolderName: z.string().nullable(),
});
