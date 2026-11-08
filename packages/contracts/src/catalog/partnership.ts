import * as z from 'zod';
import { normalizeDigits } from '../text/digits.js';
import { normalizeMedicalCouncilNumber } from '../text/medical-council.js';
import { normalizeMobile } from '../text/mobile.js';
import { normalizePersianText } from '../text/persian.js';
import { CENTER_PERSON_TYPES } from './centers.js';

/**
 * A center's or a doctor's request to join (owner 1405/08/10; migration 0110): sent from the
 * public page with a mobile proved by a code, its documents scanned. The network specialist
 * reviews it and registers the center as a draft; the network manager, another person,
 * approves it, which makes the center manager's account and sends its one-time link. No
 * center is ever activated by a request: activation stays the two-person path of doc 08.
 */

const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const isoInstant = z.iso.datetime({ offset: true });

export const PLACE_KINDS = [
  'practice',
  'clinic',
  'polyclinic',
  'hospital',
  'day_surgery',
  'imaging',
  'laboratory',
  'dental',
] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
export const PLACE_KIND_NAMES: Readonly<Record<PlaceKind, string>> = {
  practice: 'مطب',
  clinic: 'کلینیک',
  polyclinic: 'درمانگاه',
  hospital: 'بیمارستان',
  day_surgery: 'مرکز جراحی محدود',
  imaging: 'مرکز تصویربرداری',
  laboratory: 'آزمایشگاه',
  dental: 'مرکز دندان‌پزشکی',
};

export const PARTNERSHIP_DOCUMENTS = ['license', 'owner_id', 'iban', 'gazette'] as const;
export type PartnershipDocument = (typeof PARTNERSHIP_DOCUMENTS)[number];
export const PARTNERSHIP_DOCUMENT_NAMES: Readonly<Record<PartnershipDocument, string>> = {
  license: 'پروانه فعالیت یا بهره‌برداری',
  owner_id: 'کارت ملی مسئول',
  iban: 'گواهی شماره شبا',
  gazette: 'روزنامه رسمی آخرین تغییرات',
};
/** The documents a request needs: the gazette for a legal person only; the Sheba never. */
export const requiredDocuments = (personType: 'natural' | 'legal'): PartnershipDocument[] =>
  personType === 'legal' ? ['license', 'owner_id', 'gazette'] : ['license', 'owner_id'];
export const PARTNERSHIP_FILE_MAX_BYTES = 10 * 1024 * 1024;

export const PARTNERSHIP_STATUSES = ['pending', 'reviewed', 'approved', 'rejected'] as const;
export type PartnershipStatus = (typeof PARTNERSHIP_STATUSES)[number];

const mobile = z.string().transform((v, ctx) => {
  const m = normalizeMobile(v);
  if (!m) {
    ctx.addIssue({ code: 'custom', message: 'invalid mobile' });
    return z.NEVER;
  }
  return m;
});

export const partnershipDoctorSchema = z.object({
  name: text(3, 120),
  councilNumber: z.string().transform((v, ctx) => {
    const n = normalizeMedicalCouncilNumber(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'invalid medical council number' });
      return z.NEVER;
    }
    return n;
  }),
  specialty: text(2, 120).nullable().default(null),
});

/** The anti-bot proof: a server challenge and the counter that solves it (no outside service). */
export const proofOfWorkSchema = z.object({
  challenge: z.string().min(10).max(300),
  counter: z.int().nonnegative(),
});

/** `POST /catalog/partnership/code`: a code to the applicant's mobile. */
export const partnershipCodeRequestSchema = z.object({
  mobile,
  proof: proofOfWorkSchema,
  /** A field people never see; a bot fills it, and is refused without a reason. */
  website: z.string().max(200).default(''),
});

/** The request's fields; sent as JSON in the multipart `request` field with its files. */
export const partnershipRequestSchema = z.object({
  centerName: text(3, 200),
  placeKind: z.enum(PLACE_KINDS),
  personType: z.enum(CENTER_PERSON_TYPES),
  cityCode: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  treatmentFieldCodes: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/))
    .min(1)
    .max(20),
  address: text(10, 300),
  phone: z
    .string()
    .transform((v) => normalizeDigits(v).replace(/[\s\-()]/g, ''))
    .pipe(z.string().regex(/^0\d{9,10}$/))
    .nullable()
    .default(null),
  managerName: text(3, 120),
  managerRole: text(2, 80).nullable().default(null),
  mobile,
  code: z.string().regex(/^\d{6}$/),
  doctors: z.array(partnershipDoctorSchema).min(1).max(20),
  proof: proofOfWorkSchema,
  website: z.string().max(200).default(''),
});
export type PartnershipRequestInput = z.input<typeof partnershipRequestSchema>;

/** The multipart field holding {@link partnershipRequestSchema} as JSON. */
export const partnershipRequestFieldsSchema = z.object({ request: z.string().min(2).max(20_000) });

export const partnershipReceiptSchema = z.object({ number: z.int().positive() });

export const powChallengeSchema = z.object({
  challenge: z.string(),
  /** Leading zero bits the SHA-256 of `challenge:counter` must have. */
  bits: z.int().min(1).max(32),
  expiresAt: isoInstant,
});
export type PowChallenge = z.infer<typeof powChallengeSchema>;

export const partnershipDocumentViewSchema = z.object({
  id: z.uuid(),
  kind: z.enum(PARTNERSHIP_DOCUMENTS),
  contentType: z.string(),
  sizeBytes: z.int(),
});

export const partnershipEventViewSchema = z.object({
  action: z.string(),
  actorAccountId: z.uuid().nullable(),
  note: z.string().nullable(),
  createdAt: isoInstant,
});

export const partnershipSummarySchema = z.object({
  id: z.uuid(),
  number: z.int(),
  centerName: z.string(),
  placeKind: z.enum(PLACE_KINDS),
  cityCode: z.string(),
  managerName: z.string(),
  status: z.enum(PARTNERSHIP_STATUSES),
  createdAt: isoInstant,
});
export type PartnershipSummary = z.infer<typeof partnershipSummarySchema>;

export const partnershipViewSchema = partnershipSummarySchema.extend({
  personType: z.enum(CENTER_PERSON_TYPES),
  treatmentFieldCodes: z.array(z.string()),
  address: z.string(),
  phone: z.string().nullable(),
  managerRole: z.string().nullable(),
  /** Masked except the last four digits: the full number is the applicant's. */
  mobileLastFour: z.string(),
  doctors: z.array(
    z.object({ name: z.string(), councilNumber: z.string(), specialty: z.string().nullable() }),
  ),
  rejectionReason: z.string().nullable(),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: isoInstant.nullable(),
  reviewNote: z.string().nullable(),
  approvedBy: z.uuid().nullable(),
  approvedAt: isoInstant.nullable(),
  centerId: z.uuid().nullable(),
  accountId: z.uuid().nullable(),
  documents: z.array(partnershipDocumentViewSchema),
  events: z.array(partnershipEventViewSchema),
});
export type PartnershipView = z.infer<typeof partnershipViewSchema>;

/**
 * The specialist's review: the identifier read from the documents (national ID of a natural
 * person, legal-entity ID of a legal one) and a note; the center is registered as a draft.
 */
export const partnershipReviewSchema = z.object({
  identifier: z.string().min(5).max(20),
  licenseNumber: text(2, 60).nullable().default(null),
  note: text(3, 500),
});

export const partnershipApproveSchema = z.object({ note: text(3, 500) });
export const partnershipRejectSchema = z.object({ reason: text(3, 300) });
