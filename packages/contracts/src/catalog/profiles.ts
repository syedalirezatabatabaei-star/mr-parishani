import * as z from 'zod';
import { normalizePersianText } from '../text/persian.js';

/**
 * A doctor's public profile (task 2-8, doc 08 §10). Every change is a version; only an
 * approved (published) one is ever shown to the public.
 */

export const PROFILE_VERSION_STATUSES = ['draft', 'in_review', 'published', 'rejected'] as const;
export type ProfileVersionStatus = (typeof PROFILE_VERSION_STATUSES)[number];

/**
 * doc 08 §10: `draft → in_review → published | rejected`. A rejected version stays as it
 * was (history); the next edit starts a new draft. The database guards the same moves.
 */
export const PROFILE_VERSION_TRANSITIONS: Readonly<
  Record<ProfileVersionStatus, readonly ProfileVersionStatus[]>
> = {
  draft: ['in_review'],
  in_review: ['published', 'rejected'],
  published: [],
  rejected: [],
};

/**
 * The Latin address of a profile, `/doctors/<slug>` (doc 08 §10): lower-case letters and
 * digits in hyphen-joined words. A slug once used belongs to that profile for ever, so an
 * old address always redirects (301) to the current one.
 */
export const profileSlugSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  );

const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 500);

export const SOCIAL_KINDS = [
  'instagram',
  'telegram',
  'linkedin',
  'aparat',
  'eitaa',
  'bale',
  'rubika',
  'website',
] as const;

/** The video of a profile: an Aparat video id, or one uploaded and served by Sepehr. */
export const profileVideoSchema = z.discriminatedUnion('hosting', [
  z.object({ hosting: z.literal('aparat'), aparatId: z.string().regex(/^[A-Za-z0-9]{3,20}$/) }),
  z.object({ hosting: z.literal('self'), assetId: z.uuid() }),
]);
export type ProfileVideo = z.output<typeof profileVideoSchema>;

/** What a profile says besides the catalog's own data (name, council number, workplaces). */
export const profileContentSchema = z.object({
  /** The specialty as the doctor writes it, e.g. «متخصص ارتودنسی». */
  specialtyTitle: text(2, 200).optional(),
  biography: text(0, 5000).optional(),
  /** Education and career, one item per line of the profile. */
  history: z.array(text(2, 300)).max(30).optional(),
  socials: z
    .array(z.object({ kind: z.enum(SOCIAL_KINDS), url: z.url({ protocol: /^https$/ }).max(300) }))
    .max(10)
    .optional(),
  photoAssetId: z.uuid().nullable().optional(),
  video: profileVideoSchema.nullable().optional(),
});
export type ProfileContent = z.output<typeof profileContentSchema>;

export const createProfileSchema = z.object({ slug: profileSlugSchema, reason });
export const changeProfileSlugSchema = z.object({ slug: profileSlugSchema, reason });
export const saveProfileDraftSchema = profileContentSchema.extend({ reason });
export const profileDecisionSchema = z.object({ reason });

// --- media ---------------------------------------------------------------------------------

export const MEDIA_ASSET_STATUSES = ['pending', 'ready', 'rejected'] as const;
export type MediaAssetStatus = (typeof MEDIA_ASSET_STATUSES)[number];

/** Why a file was not taken; `infected` never names what was found to the uploader. */
export const MEDIA_REJECTIONS = [
  'unsupported_type',
  'infected',
  'too_long',
  'processing_failed',
] as const;
export type MediaRejection = (typeof MEDIA_REJECTIONS)[number];

/** The largest file the API accepts at all; the config's own limits are within it. */
export const MEDIA_UPLOAD_HARD_LIMIT_BYTES = 110 * 1024 * 1024;

const isoInstant = z.iso.datetime({ offset: true });

/** A published file's variants (photo sizes, video renditions), served from public storage. */
const publicMediaSchema = z.object({
  variants: z.array(
    z.object({ mime: z.string(), width: z.int().positive().optional(), url: z.string() }),
  ),
});

/**
 * `GET /public/doctors/:slug` (doc 08 §10): the published version only, for the public
 * page of the doctor (task 2-11, server-rendered with its structured data).
 */
export const publicProfileSchema = z.object({
  slug: z.string(),
  /** Not `doctorName`: that name is the treatment field class of doc 04 §4. */
  doctor: z.object({ id: z.uuid(), name: z.string() }),
  medicalCouncilNumber: z.string(),
  treatmentFields: z.array(z.object({ code: z.string(), name: z.string() })),
  specialtyTitle: z.string().nullable(),
  biography: z.string().nullable(),
  history: z.array(z.string()),
  socials: z.array(z.object({ kind: z.enum(SOCIAL_KINDS), url: z.string() })),
  photo: publicMediaSchema.nullable(),
  video: z
    .discriminatedUnion('hosting', [
      z.object({ hosting: z.literal('aparat'), aparatId: z.string() }),
      publicMediaSchema.extend({ hosting: z.literal('self') }),
    ])
    .nullable(),
  workplaces: z.array(
    z.object({
      workplaceId: z.uuid(),
      placeName: z.string().nullable(),
      branchName: z.string().nullable(),
      address: z.string().nullable(),
      cityCode: z.string(),
      services: z.array(
        z.object({
          serviceCode: z.string(),
          serviceName: z.string(),
          isFree: z.boolean(),
          minRial: z.string().regex(/^\d+$/),
          maxRial: z.string().regex(/^\d+$/),
        }),
      ),
    }),
  ),
  withSepehrSince: isoInstant.nullable(),
  publishedAt: isoInstant.nullable(),
  /**
   * Task 8-3: search engines may index it: published and with at least one listed workplace
   * (it takes appointments). Otherwise the page still shows, `noindex`, and is not in the
   * sitemap.
   */
  indexable: z.boolean(),
});
export type PublicProfile = z.infer<typeof publicProfileSchema>;

/**
 * `GET /public/workplaces/:id` (task 2-11, the booking page): a listed workplace as search
 * shows it, with every priced service; the profile address when one is published.
 */
export const publicWorkplaceSchema = z.object({
  workplaceId: z.uuid(),
  doctor: z.object({ id: z.uuid(), name: z.string() }),
  profileSlug: z.string().nullable(),
  placeName: z.string().nullable(),
  branchName: z.string().nullable(),
  address: z.string().nullable(),
  cityCode: z.string(),
  treatmentFields: z.array(z.object({ code: z.string(), name: z.string() })),
  creditEnabled: z.boolean(),
  services: z.array(
    z.object({
      serviceCode: z.string(),
      serviceName: z.string(),
      isVisit: z.boolean(),
      isFree: z.boolean(),
      minRial: z.string().regex(/^\d+$/),
      maxRial: z.string().regex(/^\d+$/),
    }),
  ),
});
export type PublicWorkplace = z.infer<typeof publicWorkplaceSchema>;

/** `GET /catalog/profile-reviews`: versions waiting for the network specialist, oldest first. */
export const profileReviewQueueSchema = z.array(
  z.object({
    versionId: z.uuid(),
    versionNo: z.int().positive(),
    submittedAt: isoInstant,
    profileId: z.uuid(),
    slug: z.string(),
    doctor: z.object({ id: z.uuid(), name: z.string() }),
  }),
);

/** One version of a profile as its editors and reviewers see it. */
export const profileVersionViewSchema = z.object({
  id: z.uuid(),
  versionNo: z.int().positive(),
  status: z.enum(PROFILE_VERSION_STATUSES),
  content: z.looseObject({
    specialtyTitle: z.string().optional(),
    biography: z.string().optional(),
    history: z.array(z.string()).optional(),
    socials: z.array(z.object({ kind: z.string(), url: z.string() })).optional(),
    photoAssetId: z.uuid().nullable().optional(),
    video: z.unknown().optional(),
  }),
  submittedAt: isoInstant.nullable(),
  decidedAt: isoInstant.nullable(),
  decisionReason: z.string().nullable(),
});
export type ProfileVersionBody = z.infer<typeof profileVersionViewSchema>;

/** `GET /catalog/doctors/:id/profile`: the published version, the open one, the files. */
export const profileEditorViewSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  published: profileVersionViewSchema.nullable(),
  open: profileVersionViewSchema.nullable(),
  history: z.array(profileVersionViewSchema),
  media: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['image', 'video']),
      status: z.string(),
      rejection: z.string().nullable(),
      mime: z.string().nullable(),
      sizeBytes: z.int().nullable(),
    }),
  ),
});
export type ProfileEditorView = z.infer<typeof profileEditorViewSchema>;

/** `POST /catalog/doctors/:id/profile`: the new profile and its first draft. */
export const profileCreatedSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  draft: profileVersionViewSchema,
});

/** Task 8-3: a published profile's address, for the sitemap and the WordPress link list. */
export const publishedProfileLinkSchema = z.object({
  slug: z.string(),
  name: z.string(),
  indexable: z.boolean(),
  /** When its published version was approved: the sitemap's lastmod. */
  lastModified: isoInstant.nullable(),
});
export type PublishedProfileLink = z.output<typeof publishedProfileLinkSchema>;

/** `PUT /catalog/doctors/:id/profile/slug`: the profile and its address now. */
export const profileSlugViewSchema = z.object({ id: z.uuid(), slug: z.string() });

/** `POST /catalog/doctors/:id/media`: the uploaded file, as scanned and checked. */
export const profileMediaViewSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['image', 'video']),
  status: z.string(),
  rejection: z.string().nullable(),
  mime: z.string(),
  sizeBytes: z.int(),
});

/** `GET /catalog/media/:id`: the file with short-lived signed links to its variants. */
export const profileMediaDetailSchema = profileMediaViewSchema.extend({
  variants: z.array(z.object({ mime: z.string(), width: z.int().optional(), url: z.string() })),
  linksExpireInSeconds: z.int(),
});
