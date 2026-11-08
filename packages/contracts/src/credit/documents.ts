import * as z from 'zod';
import { normalizePersianText } from '../text/persian.js';
import { CONSENT_ROLES } from './scoring-sheets.js';

/**
 * Documents of a credit application (doc 10 §4; task 3-5 part C): a versioned checklist
 * per role (and job, when known), uploaded to private storage, scanned, seen only through
 * a short signed link and every view logged (doc 04 §7), accepted or rejected with a
 * reason by the case-completion specialist.
 */

export const CREDIT_DOCUMENT_STATUSES = [
  'submitted',
  'accepted',
  'rejected',
  'superseded',
] as const;
export type CreditDocumentStatus = (typeof CREDIT_DOCUMENT_STATUSES)[number];

const code = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));

/** The configuration key `credit.document_checklist`. */
export const creditDocumentChecklistSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          code,
          title: z.string().min(2).max(200),
          roles: z.array(z.enum(CONSENT_ROLES)).min(1),
          /** Only for these job options (scoring criterion `job`); null: every job. */
          jobs: z.array(code).min(1).nullable(),
          required: z.boolean(),
        }),
      )
      .max(100),
  })
  .refine((v) => new Set(v.items.map((i) => i.code)).size === v.items.length, {
    message: 'a document code appears twice',
  });
export type CreditDocumentChecklist = z.infer<typeof creditDocumentChecklistSchema>;

/** The configuration key `credit.document_policy`. */
export const creditDocumentPolicySchema = z.strictObject({
  maxBytes: z
    .number()
    .int()
    .min(100_000)
    .max(50 * 1024 * 1024),
  signedUrlSeconds: z.number().int().min(30).max(3600),
});

/** The text fields of a multipart upload (the file itself is `file`). */
export const uploadCreditDocumentSchema = z.strictObject({
  role: z.enum(CONSENT_ROLES),
  itemCode: code,
});

export const decideCreditDocumentSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('accept') }),
  z.strictObject({ decision: z.literal('reject'), reason: text(3, 500) }),
]);

const instant = z.iso.datetime({ offset: true });

export const creditDocumentViewSchema = z.object({
  id: z.uuid(),
  itemCode: z.string(),
  role: z.enum(CONSENT_ROLES),
  status: z.enum(CREDIT_DOCUMENT_STATUSES),
  mime: z.string(),
  sizeBytes: z.int().positive(),
  reason: z.string().nullable(),
  uploadedAt: instant,
  decidedAt: instant.nullable(),
});

export const creditDocumentItemSchema = z.object({
  itemCode: z.string(),
  title: z.string(),
  role: z.enum(CONSENT_ROLES),
  required: z.boolean(),
  /** The current upload of this item, if any. */
  document: creditDocumentViewSchema.nullable(),
});

/** One person's checklist: the borrower, or a guarantor by id. */
export const creditDocumentChecklistViewSchema = z.object({
  people: z.array(
    z.object({
      role: z.enum(CONSENT_ROLES),
      guarantorId: z.uuid().nullable(),
      items: z.array(creditDocumentItemSchema),
    }),
  ),
});

export const creditDocumentLinkSchema = z.object({
  url: z.string().min(1),
  expiresInSeconds: z.int().positive(),
});
