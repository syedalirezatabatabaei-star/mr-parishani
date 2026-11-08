import * as z from 'zod';
import { COST_KINDS, rialAmountSchema } from '../catalog/tariffs.js';
import { normalizeDigits } from '../text/digits.js';
import { normalizePersianText } from '../text/persian.js';

/**
 * Proformas (doc 10 §2; task 3-4): what a doctor proposes to do and at what price, for a
 * patient referred to them through Sepehr. Versioned: once issued nothing in it changes;
 * a correction is a new version. Amounts in rials (rule 1), as text in the API.
 */

export const PROFORMA_STATUSES = [
  'draft',
  'issued',
  'patient_confirmed',
  'disputed',
  'superseded',
  'expired',
] as const;
export type ProformaStatus = (typeof PROFORMA_STATUSES)[number];

const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const serviceCode = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const quantity = z
  .union([
    z.number(),
    z.string().transform(normalizeDigits).pipe(z.string().regex(/^\d+$/)).transform(Number),
  ])
  .pipe(z.number().int().min(1).max(99));

export const proformaLineInputSchema = z.strictObject({
  serviceCode,
  quantity,
  /** Omitted: the tariff's price when it is a single amount; required for a range. */
  unitRial: rialAmountSchema.optional(),
  /** Required when the price is outside the tariff's range (doc 10 §2 rule 2). */
  deviationReason: text(3, 500).optional(),
  /** Treatment data (doc 04 §4): shown only to whoever may see treatment. */
  toothOrSite: text(1, 100).optional(),
  note: text(1, 500).optional(),
  /**
   * ADR-050: the line's cost kind, when the issuer splits it otherwise than its service does
   * (the service's by default); a different one needs its reason. Issuing confirms the split.
   */
  costKind: z.enum(COST_KINDS).optional(),
  costKindReason: text(3, 500).optional(),
});
export type ProformaLineInput = z.input<typeof proformaLineInputSchema>;

const lines = z.array(proformaLineInputSchema).min(1).max(50);

/** A draft for the patient of an appointment made through Sepehr (its referral). */
export const createProformaSchema = z.strictObject({
  appointmentId: z.uuid(),
  lines,
});
export type CreateProforma = z.input<typeof createProformaSchema>;

/** A new version of an issued, disputed or expired proforma, as a draft. */
export const reviseProformaSchema = z.strictObject({ lines });
export type ReviseProforma = z.input<typeof reviseProformaSchema>;

export const discardProformaSchema = z.strictObject({ reason: text(3, 500) });
export const disputeProformaSchema = z.strictObject({ note: text(3, 1000) });
export const reviewDeviationSchema = z.strictObject({ note: text(3, 1000) });

const pageNumber = (max: number) =>
  z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^[1-9][0-9]{0,3}$/))
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

export const proformaListQuerySchema = z.object({
  workplaceId: z.uuid().optional(),
  status: z.enum(PROFORMA_STATUSES).optional(),
  page: pageNumber(1000).optional(),
  pageSize: pageNumber(50).optional(),
});

export const deviationQueueQuerySchema = z.object({
  /** Not yet reviewed only (default), or every issued proforma with a deviation. */
  reviewed: z.enum(['no', 'all']).optional(),
  page: pageNumber(1000).optional(),
  pageSize: pageNumber(50).optional(),
});

const rial = z.string().regex(/^\d+$/);
const instant = z.iso.datetime({ offset: true });

export const proformaLineViewSchema = z.object({
  lineNo: z.int().positive(),
  serviceCode: z.string(),
  serviceName: z.string(),
  quantity: z.int().positive(),
  tariffVersionId: z.uuid(),
  tariffMinRial: rial,
  tariffMaxRial: rial,
  unitRial: rial,
  lineTotalRial: rial,
  /** The price is outside the tariff's range. */
  deviates: z.boolean(),
  deviationReason: z.string().nullable(),
  /** ADR-050: the doctor's wage or materials, as the issuer confirmed it. */
  costKind: z.enum(COST_KINDS),
  costKindReason: z.string().nullable(),
  /** Present only for whoever may see treatment (access.view_treatment) and the patient. */
  toothOrSite: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const proformaViewSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  workplaceId: z.uuid(),
  doctorId: z.uuid(),
  doctorName: z.string(),
  placeName: z.string().nullable(),
  version: z.int().positive(),
  supersedesId: z.uuid().nullable(),
  status: z.enum(PROFORMA_STATUSES),
  totalRial: rial,
  validUntil: instant.nullable(),
  issuedAt: instant.nullable(),
  patientRespondedAt: instant.nullable(),
  patientResponseNote: z.string().nullable(),
  createdAt: instant,
  lines: z.array(proformaLineViewSchema),
});
export type ProformaView = z.infer<typeof proformaViewSchema>;

export const proformaListSchema = z.object({
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  items: z.array(proformaViewSchema),
});
