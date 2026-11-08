import * as z from 'zod';
import { normalizePersianText } from '../text/persian.js';

/**
 * The portal's content (owner 1405/08/10; migration 0110): the desk's banners, the text
 * pages and the announcements. Each change is a version proposed by the system admin and
 * decided by another person (`config.propose_content`, `config.approve_content`).
 */

const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 500);
const isoInstant = z.iso.datetime({ offset: true });

/** A link inside the site only: a path, never another site (no external dependency). */
export const sitePath = z
  .string()
  .trim()
  .regex(/^\/[^/]/, 'a path starting with /')
  .max(300);

export const CONTENT_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Who a banner is for: the desk of a patient, a center, a doctor, the internal panel. */
export const BANNER_AUDIENCES = ['patient', 'center', 'doctor', 'staff'] as const;
export type BannerAudience = (typeof BANNER_AUDIENCES)[number];
export const BANNER_TONES = ['accent', 'highlight', 'indigo', 'teal', 'rose', 'amber'] as const;
/** At most this many banners in force for one audience at a time. */
export const MAX_ACTIVE_BANNERS = 5;

export const bannerProposalSchema = z.object({
  /** A new banner when left out; else a new version of this one. */
  bannerKey: z.uuid().optional(),
  title: text(2, 80),
  body: text(2, 200),
  tone: z.enum(BANNER_TONES),
  linkHref: sitePath.nullable().default(null),
  linkLabel: text(2, 40).nullable().default(null),
  sortOrder: z.int().min(0).max(99).default(0),
  startsAt: isoInstant,
  endsAt: isoInstant.nullable().default(null),
  audiences: z.array(z.enum(BANNER_AUDIENCES)).min(1).max(4),
  active: z.boolean(),
  displaySeconds: z.int().min(3).max(30).default(6),
  reason,
});
export type BannerProposal = z.input<typeof bannerProposalSchema>;

/** The multipart fields of a proposal with its picture: the proposal as JSON. */
export const bannerProposalFieldsSchema = z.object({ proposal: z.string().min(2).max(5000) });

const proposalMeta = {
  id: z.uuid(),
  version: z.int().positive(),
  status: z.enum(CONTENT_STATUSES),
  reason: z.string(),
  proposedBy: z.uuid(),
  decidedBy: z.uuid().nullable(),
  decidedAt: isoInstant.nullable(),
  decisionReason: z.string().nullable(),
  createdAt: isoInstant,
};

export const bannerViewSchema = z.object({
  ...proposalMeta,
  bannerKey: z.uuid(),
  title: z.string(),
  body: z.string(),
  tone: z.enum(BANNER_TONES),
  hasImage: z.boolean(),
  linkHref: z.string().nullable(),
  linkLabel: z.string().nullable(),
  sortOrder: z.int(),
  startsAt: isoInstant,
  endsAt: isoInstant.nullable(),
  audiences: z.array(z.enum(BANNER_AUDIENCES)),
  active: z.boolean(),
  displaySeconds: z.int(),
});
export type BannerView = z.infer<typeof bannerViewSchema>;

/** A banner as a desk shows it: in force, for this audience, its picture a short link. */
export const deskBannerSchema = z.object({
  bannerKey: z.uuid(),
  title: z.string(),
  body: z.string(),
  tone: z.enum(BANNER_TONES),
  imageUrl: z.string().nullable(),
  linkHref: z.string().nullable(),
  linkLabel: z.string().nullable(),
  displaySeconds: z.int(),
});
export const deskBannerListSchema = z.array(deskBannerSchema);
export type DeskBanner = z.infer<typeof deskBannerSchema>;

export const contentDecisionSchema = z.object({
  approve: z.boolean(),
  reason: reason.optional(),
});

// --- text pages -----------------------------------------------------------------------

export const CONTENT_SLUGS = ['about', 'terms', 'privacy', 'contact', 'help', 'faq'] as const;
export type ContentSlug = (typeof CONTENT_SLUGS)[number];
export const CONTENT_SLUG_TITLES: Readonly<Record<ContentSlug, string>> = {
  about: 'درباره سپهر سلامتی',
  terms: 'قوانین و شرایط',
  privacy: 'حریم خصوصی',
  contact: 'تماس با ما',
  help: 'راهنما',
  faq: 'پرسش‌های متداول',
};

/** A link a page may hold: a path of the site, a phone or an email. */
const pageLink = z
  .string()
  .trim()
  .regex(/^(\/[^/]|tel:\+?[0-9]{4,15}$|mailto:[^\s@]+@[^\s@]+$)/, 'a path, tel: or mailto:')
  .max(300);

/** The blocks of a page: the simple editor's headings, paragraphs, lists and links. */
export const contentBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('heading'), text: text(1, 120) }),
  z.object({ kind: z.literal('paragraph'), text: text(1, 3000) }),
  z.object({ kind: z.literal('list'), items: z.array(text(1, 500)).min(1).max(30) }),
  z.object({ kind: z.literal('link'), text: text(1, 120), href: pageLink }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const pageProposalSchema = z.object({
  title: text(2, 120),
  blocks: z.array(contentBlockSchema).min(1).max(100),
  reason,
});
export type PageProposal = z.input<typeof pageProposalSchema>;

export const pageViewSchema = z.object({
  ...proposalMeta,
  slug: z.enum(CONTENT_SLUGS),
  title: z.string(),
  blocks: z.array(contentBlockSchema),
});
export type PageView = z.infer<typeof pageViewSchema>;

/** A page as the public reads it: the version in force, or 404. */
export const publicPageSchema = z.object({
  slug: z.enum(CONTENT_SLUGS),
  title: z.string(),
  blocks: z.array(contentBlockSchema),
  version: z.int().positive(),
  updatedAt: isoInstant,
});
export type PublicPage = z.infer<typeof publicPageSchema>;

// --- announcements --------------------------------------------------------------------

export const ANNOUNCEMENT_AUDIENCES = ['all', 'patients', 'centers', 'staff', 'role'] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export const announcementProposalSchema = z
  .object({
    announcementKey: z.uuid().optional(),
    title: text(2, 120),
    body: text(2, 1000),
    audience: z.enum(ANNOUNCEMENT_AUDIENCES),
    roleCode: z
      .string()
      .regex(/^[a-z][a-z_]{1,62}$/)
      .nullable()
      .default(null),
    urgent: z.boolean(),
    startsAt: isoInstant,
    endsAt: isoInstant.nullable().default(null),
    active: z.boolean(),
    reason,
  })
  .refine((v) => (v.audience === 'role') === (v.roleCode !== null), {
    message: 'a role audience names its role, and only it',
    path: ['roleCode'],
  });
export type AnnouncementProposal = z.input<typeof announcementProposalSchema>;

export const announcementViewSchema = z.object({
  ...proposalMeta,
  announcementKey: z.uuid(),
  title: z.string(),
  body: z.string(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES),
  roleCode: z.string().nullable(),
  urgent: z.boolean(),
  startsAt: isoInstant,
  endsAt: isoInstant.nullable(),
  active: z.boolean(),
});
export type AnnouncementView = z.infer<typeof announcementViewSchema>;
