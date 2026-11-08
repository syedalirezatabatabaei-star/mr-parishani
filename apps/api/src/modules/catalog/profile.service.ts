import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  profileContentSchema,
  type changeProfileSlugSchema,
  type createProfileSchema,
  type MediaAssetStatus,
  type PermissionCode,
  type ProfileContent,
  type saveProfileDraftSchema,
  type PublishedProfileLink,
} from '@sepehr/contracts';
import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';
import { scannerUnavailable } from '../../infra/clamd';
import { detectFileType } from '../../infra/file-type';
import { storageUnavailable } from '../../infra/s3-storage';
import {
  doctorProfiles,
  doctorProfileSlugs,
  doctorProfileVersions,
  doctors,
  mediaAssets,
} from './catalog.schema';
import { DoctorService } from './doctor.service';
import { SearchIndex } from './search-index';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type VersionRow = typeof doctorProfileVersions.$inferSelect;
type ProfileRow = typeof doctorProfiles.$inferSelect;
type AssetRow = typeof mediaAssets.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE: PermissionCode = 'catalog.manage_doctors';
const REVIEW: PermissionCode = 'catalog.review_profiles';

/** The type a file name promises; a name promising another type than the bytes is refused. */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export interface UploadedMedia {
  readonly originalname: string;
  readonly size: number;
  readonly buffer: Buffer;
}

export interface VersionView {
  readonly id: string;
  readonly versionNo: number;
  readonly status: string;
  readonly content: ProfileContent;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}

export interface MediaView {
  readonly id: string;
  readonly kind: 'image' | 'video';
  readonly status: MediaAssetStatus;
  readonly rejection: string | null;
  readonly mime: string;
  readonly sizeBytes: number;
}

const versionView = (row: VersionRow): VersionView => ({
  id: row.id,
  versionNo: row.versionNo,
  status: row.status,
  content: row.content,
  submittedAt: row.submittedAt?.toISOString() ?? null,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  decisionReason: row.decisionReason,
});

const mediaView = (row: AssetRow): MediaView => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  rejection: row.rejection,
  mime: row.detectedMime,
  sizeBytes: row.sizeBytes,
});

const pgCode = (error: unknown): { code?: string; constraint?: string } | undefined => {
  const e = error as { code?: string; constraint?: string; cause?: unknown } | null;
  if (e?.code) return e;
  return (e?.cause as { code?: string; constraint?: string } | undefined) ?? undefined;
};

/**
 * Doctors' public profiles and their media (task 2-8, doc 08 §10, ADR-029).
 *
 * - Content is versioned: `draft → in_review → published | rejected`. Editing a published
 *   profile opens a new draft; the published version stays public until a newer one is
 *   approved. Only the network specialist approves (catalog.review_profiles), and nothing
 *   is ever public unapproved (doc 09 open item 8).
 * - Who edits: whoever may edit the doctor (DoctorService.update's rule). The address
 *   (slug) is the network's; every slug ever used stays the profile's, for the 301.
 * - Files: the real type from the bytes (a name promising another type is refused), a size
 *   limit from the config, then the private space; the worker scans and processes them
 *   (MediaWorker). Nothing leaves the private space before a published version shows it.
 */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    private readonly doctorsService: DoctorService,
    private readonly searchIndex: SearchIndex,
  ) {}

  // --- the profile ----------------------------------------------------------------------

  /** A profile with its first address and an empty draft: the network only. */
  async create(
    actor: Actor,
    access: EffectiveAccess,
    doctorId: string,
    input: z.output<typeof createProfileSchema>,
  ) {
    this.require(access, MANAGE);
    return this.db.transaction(async (tx) => {
      const { network } = await this.doctorsService.profileEditor(tx, actor, access, doctorId);
      if (!network) throw new ForbiddenException({ error: 'network_only' });
      const [profile] = await this.unique(() =>
        tx
          .insert(doctorProfiles)
          .values({ doctorId, slug: input.slug, createdBy: actor.accountId })
          .returning(),
      );
      if (!profile) throw new Error('profile insert returned nothing');
      await this.unique(() =>
        tx
          .insert(doctorProfileSlugs)
          .values({ profileId: profile.id, slug: input.slug, createdBy: actor.accountId })
          .returning(),
      );
      const [draft] = await tx
        .insert(doctorProfileVersions)
        .values({
          profileId: profile.id,
          versionNo: 1,
          status: 'draft',
          content: {},
          createdBy: actor.accountId,
        })
        .returning();
      if (!draft) throw new Error('version insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'catalog.profile_created',
          entityType: 'doctor_profile',
          entityId: profile.id,
          after: { doctorId, slug: profile.slug },
          reason: input.reason,
        },
        tx,
      );
      return { id: profile.id, slug: profile.slug, draft: versionView(draft) };
    });
  }

  /** The profile as its editors see it: the published version, the open one, the media. */
  async get(actor: Actor, access: EffectiveAccess, doctorId: string) {
    this.require(access, MANAGE);
    return this.db.transaction(async (tx) => {
      await this.doctorsService.profileEditor(tx, actor, access, doctorId);
      const profile = await this.profileOf(tx, doctorId);
      const versions = await tx
        .select()
        .from(doctorProfileVersions)
        .where(eq(doctorProfileVersions.profileId, profile.id))
        .orderBy(desc(doctorProfileVersions.versionNo));
      const media = await tx
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.doctorId, doctorId))
        .orderBy(asc(mediaAssets.createdAt));
      const open = versions.find((v) => v.status === 'draft' || v.status === 'in_review');
      const published = versions.find((v) => v.id === profile.publishedVersionId);
      return {
        id: profile.id,
        slug: profile.slug,
        published: published ? versionView(published) : null,
        open: open ? versionView(open) : null,
        history: versions.map(versionView),
        media: media.map(mediaView),
      };
    });
  }

  /**
   * Saves the draft: the open draft, or a new one started from the published content. The
   * given fields replace those of the draft; a version in review cannot change.
   */
  async saveDraft(
    actor: Actor,
    access: EffectiveAccess,
    doctorId: string,
    input: z.output<typeof saveProfileDraftSchema>,
  ): Promise<VersionView> {
    this.require(access, MANAGE);
    const { reason, ...fields } = input;
    return this.db.transaction(async (tx) => {
      const { auditActor } = await this.doctorsService.profileEditor(tx, actor, access, doctorId);
      const profile = await this.profileOf(tx, doctorId, true);
      await this.requireMedia(tx, doctorId, fields);
      let draft = await this.openVersion(tx, profile.id);
      if (draft?.status === 'in_review')
        throw new ConflictException({ error: 'profile_in_review' });
      const before = draft ? (draft.content as ProfileContent) : null;
      if (!draft) {
        const base = profile.publishedVersionId
          ? await this.versionById(tx, profile.publishedVersionId)
          : null;
        const [{ last } = { last: 0 }] = await tx
          .select({ last: max(doctorProfileVersions.versionNo) })
          .from(doctorProfileVersions)
          .where(eq(doctorProfileVersions.profileId, profile.id));
        [draft] = await tx
          .insert(doctorProfileVersions)
          .values({
            profileId: profile.id,
            versionNo: (last ?? 0) + 1,
            status: 'draft',
            content: base?.content ?? {},
            createdBy: actor.accountId,
          })
          .returning();
        if (!draft) throw new Error('version insert returned nothing');
      }
      const content = profileContentSchema.parse({ ...(draft.content as object), ...fields });
      const [after] = await tx
        .update(doctorProfileVersions)
        .set({ content })
        .where(eq(doctorProfileVersions.id, draft.id))
        .returning();
      if (!after) throw new Error('version update returned nothing');
      await this.audit.record(
        {
          actor: auditActor,
          action: 'catalog.profile_draft_saved',
          entityType: 'doctor_profile',
          entityId: profile.id,
          before: before === null ? null : { versionNo: draft.versionNo, content: before },
          after: { versionNo: after.versionNo, content },
          reason,
        },
        tx,
      );
      return versionView(after);
    });
  }

  /** The draft goes to the network for review. */
  async submit(actor: Actor, access: EffectiveAccess, doctorId: string, reason: string) {
    this.require(access, MANAGE);
    return this.db.transaction(async (tx) => {
      const { auditActor } = await this.doctorsService.profileEditor(tx, actor, access, doctorId);
      const profile = await this.profileOf(tx, doctorId, true);
      const draft = await this.openVersion(tx, profile.id);
      if (draft?.status !== 'draft') throw new ConflictException({ error: 'no_draft' });
      const [after] = await tx
        .update(doctorProfileVersions)
        .set({ status: 'in_review', submittedBy: actor.accountId, submittedAt: sql`now()` })
        .where(eq(doctorProfileVersions.id, draft.id))
        .returning();
      if (!after) throw new Error('version update returned nothing');
      await this.audit.record(
        {
          actor: auditActor,
          action: 'catalog.profile_submitted',
          entityType: 'doctor_profile',
          entityId: profile.id,
          before: { versionNo: draft.versionNo, status: 'draft' },
          after: { versionNo: after.versionNo, status: 'in_review' },
          reason,
        },
        tx,
      );
      return versionView(after);
    });
  }

  /** The versions waiting for review, of doctors in the caller's network scope. */
  async reviewQueue(access: EffectiveAccess) {
    this.require(access, REVIEW);
    const cities: string[] = [];
    let global = false;
    for (const scope of access.scopes) {
      if (scope.kind === 'global') global = true;
      if (scope.kind === 'city') cities.push(scope.code);
    }
    if (!global && cities.length === 0) return [];
    const { rows } = await this.db.execute(sql`
      SELECT v.id, v.version_no, v.submitted_at, p.id AS profile_id, p.slug, d.id AS doctor_id,
             d.name AS doctor_name
      FROM doctor_profile_versions v
      JOIN doctor_profiles p ON p.id = v.profile_id
      JOIN doctors d ON d.id = p.doctor_id
      WHERE v.status = 'in_review'
        AND ${
          global
            ? sql`true`
            : sql`EXISTS (
          SELECT 1 FROM doctor_workplaces w
          WHERE w.doctor_id = d.id AND w.deleted_at IS NULL AND w.city_code IN ${cities})`
        }
      ORDER BY v.submitted_at
    `);
    return rows.map((r) => ({
      versionId: String(r['id']),
      versionNo: Number(r['version_no']),
      submittedAt: new Date(r['submitted_at'] as string).toISOString(),
      profileId: String(r['profile_id']),
      slug: String(r['slug']),
      // Not `doctorName`: that name is the treatment field class of doc 04 §4.
      doctor: { id: String(r['doctor_id']), name: String(r['doctor_name']) },
    }));
  }

  /**
   * The network specialist approves or rejects a version in review. Approving needs every
   * file it shows processed (ready); the published version changes in the same
   * transaction, and the worker then makes its media public.
   */
  async decide(
    actor: Actor,
    access: EffectiveAccess,
    versionId: string,
    decision: 'approve' | 'reject',
    reason: string,
  ): Promise<VersionView> {
    this.require(access, REVIEW);
    if (!UUID.test(versionId)) throw new NotFoundException({ error: 'version_not_found' });
    return this.db.transaction(async (tx) => {
      const [version] = await tx
        .select()
        .from(doctorProfileVersions)
        .where(eq(doctorProfileVersions.id, versionId))
        .for('update');
      if (!version) throw new NotFoundException({ error: 'version_not_found' });
      const [profile] = await tx
        .select()
        .from(doctorProfiles)
        .where(eq(doctorProfiles.id, version.profileId))
        .for('update');
      if (!profile) throw new NotFoundException({ error: 'version_not_found' });
      const covers = await this.doctorsService
        .networkCovers(tx, access, profile.doctorId)
        .catch(() => false);
      if (!covers) throw new NotFoundException({ error: 'version_not_found' });
      if (version.status !== 'in_review') {
        throw new ConflictException({ error: 'not_in_review', status: version.status });
      }
      const content = version.content as ProfileContent;
      if (decision === 'approve') {
        const ids = [
          content.photoAssetId,
          content.video?.hosting === 'self' ? content.video.assetId : null,
        ].filter((v): v is string => typeof v === 'string');
        if (ids.length > 0) {
          const assets = await tx.select().from(mediaAssets).where(inArray(mediaAssets.id, ids));
          if (assets.length !== ids.length || assets.some((a) => a.status !== 'ready')) {
            throw new ConflictException({ error: 'media_not_ready' });
          }
        }
      }
      const status = decision === 'approve' ? 'published' : 'rejected';
      const [after] = await tx
        .update(doctorProfileVersions)
        .set({
          status,
          decidedBy: actor.accountId,
          decidedAt: sql`now()`,
          decisionReason: reason,
        })
        .where(eq(doctorProfileVersions.id, version.id))
        .returning();
      if (!after) throw new Error('version update returned nothing');
      if (decision === 'approve') {
        await tx
          .update(doctorProfiles)
          .set({
            publishedVersionId: version.id,
            firstPublishedAt: profile.firstPublishedAt ?? sql`now()`,
          })
          .where(eq(doctorProfiles.id, profile.id));
        await this.outbox.publish(
          {
            type: 'catalog.profile_published',
            aggregateType: 'doctor_profile',
            aggregateId: profile.id,
            payload: { profileId: profile.id, versionId: version.id },
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actor,
          action: decision === 'approve' ? 'catalog.profile_published' : 'catalog.profile_rejected',
          entityType: 'doctor_profile',
          entityId: profile.id,
          before: { versionNo: version.versionNo, status: 'in_review' },
          after: { versionNo: version.versionNo, status },
          reason,
        },
        tx,
      );
      return versionView(after);
    });
  }

  /** A new address; the old one redirects (301) for ever. The network only. */
  async changeSlug(
    actor: Actor,
    access: EffectiveAccess,
    doctorId: string,
    input: z.output<typeof changeProfileSlugSchema>,
  ) {
    this.require(access, REVIEW);
    return this.db.transaction(async (tx) => {
      const { network } = await this.doctorsService.profileEditor(tx, actor, access, doctorId);
      if (!network) throw new ForbiddenException({ error: 'network_only' });
      const profile = await this.profileOf(tx, doctorId, true);
      if (profile.slug === input.slug) return { id: profile.id, slug: profile.slug };
      // A slug this profile had before comes back; anyone else's is taken for ever.
      const [known] = await tx
        .select()
        .from(doctorProfileSlugs)
        .where(eq(doctorProfileSlugs.slug, input.slug));
      if (known && known.profileId !== profile.id) {
        throw new ConflictException({ error: 'slug_taken' });
      }
      if (!known) {
        await this.unique(() =>
          tx
            .insert(doctorProfileSlugs)
            .values({ profileId: profile.id, slug: input.slug, createdBy: actor.accountId })
            .returning(),
        );
      }
      await tx
        .update(doctorProfiles)
        .set({ slug: input.slug })
        .where(eq(doctorProfiles.id, profile.id));
      await this.audit.record(
        {
          actor,
          action: 'catalog.profile_slug_changed',
          entityType: 'doctor_profile',
          entityId: profile.id,
          before: { slug: profile.slug },
          after: { slug: input.slug },
          reason: input.reason,
        },
        tx,
      );
      return { id: profile.id, slug: input.slug };
    });
  }

  // --- media ----------------------------------------------------------------------------

  /**
   * An uploaded file: its type from its bytes, a name that promises the same type, the size
   * limit of its kind; then the private space and a `pending` asset for the worker.
   */
  async upload(
    actor: Actor,
    access: EffectiveAccess,
    doctorId: string,
    file: UploadedMedia | undefined,
  ): Promise<MediaView> {
    this.require(access, MANAGE);
    if (!file) throw new BadRequestException({ error: 'file_required' });
    if (!this.storage.configured) throw storageUnavailable();
    if (!this.scanner.configured) throw scannerUnavailable();
    const detected = detectFileType(file.buffer);
    const promised =
      EXTENSION_TYPES[/\.([a-z0-9]+)$/i.exec(file.originalname)?.[1]?.toLowerCase() ?? ''];
    if (!detected || !promised) throw new BadRequestException({ error: 'unsupported_type' });
    if (promised !== detected.mime) throw new BadRequestException({ error: 'type_mismatch' });
    const [policy, hosting] = await Promise.all([
      this.config.resolve('catalog.profile_media_policy'),
      this.config.resolve('catalog.profile_video_hosting'),
    ]);
    if (detected.kind === 'video' && hosting.value !== 'self') {
      throw new BadRequestException({ error: 'video_hosted_on_aparat' });
    }
    const limit =
      detected.kind === 'image' ? policy.value.imageMaxBytes : policy.value.videoMaxBytes;
    if (file.size > limit) throw new BadRequestException({ error: 'file_too_large', limit });

    // Checked before the file is stored, so a caller who may not edit stores nothing.
    const { auditActor } = await this.db.transaction((tx) =>
      this.doctorsService.profileEditor(tx, actor, access, doctorId),
    );
    const [{ id }] = (await this.db.execute(sql`SELECT uuidv7() AS id`)).rows as [{ id: string }];
    const originalKey = `media/${id}/original`;
    await this.storage.put('private', originalKey, file.buffer, detected.mime);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(mediaAssets)
        .values({
          id,
          doctorId,
          kind: detected.kind,
          status: 'pending',
          detectedMime: detected.mime,
          sizeBytes: file.size,
          originalKey,
          createdBy: actor.accountId,
        })
        .returning();
      if (!row) throw new Error('asset insert returned nothing');
      await this.audit.record(
        {
          actor: auditActor,
          action: 'catalog.media_uploaded',
          entityType: 'media_asset',
          entityId: row.id,
          after: { doctorId, ...mediaView(row) },
        },
        tx,
      );
      return mediaView(row);
    });
  }

  /** A file's state and short-lived private links to what the worker made of it. */
  async media(actor: Actor, access: EffectiveAccess, assetId: string) {
    this.require(access, MANAGE);
    if (!UUID.test(assetId)) throw new NotFoundException({ error: 'media_not_found' });
    const [asset] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    if (!asset) throw new NotFoundException({ error: 'media_not_found' });
    await this.db
      .transaction((tx) => this.doctorsService.profileEditor(tx, actor, access, asset.doctorId))
      .catch((error: unknown) => {
        throw error instanceof NotFoundException
          ? new NotFoundException({ error: 'media_not_found' })
          : error;
      });
    const seconds = (await this.config.resolve('catalog.profile_media_policy')).value
      .signedUrlSeconds;
    const variants = await Promise.all(
      (asset.variants ?? []).map(async (v) => ({
        mime: v.mime,
        ...(v.width === undefined ? {} : { width: v.width }),
        // The draft's preview, shown in the panel's own page.
        url: await this.storage.signedUrl(v.key, seconds, { inline: true }),
      })),
    );
    return { ...mediaView(asset), variants, linksExpireInSeconds: seconds };
  }

  // --- the public profile ---------------------------------------------------------------

  /**
   * What the public sees at `slug` (doc 08 §10): the published version only; an old slug
   * redirects to the current one; anything unpublished or unknown is not found (test 10).
   */
  async publicProfile(
    slug: string,
  ): Promise<{ redirect: string } | { profile: Record<string, unknown> } | null> {
    const [profile] = await this.db
      .select()
      .from(doctorProfiles)
      .where(eq(doctorProfiles.slug, slug));
    if (!profile) {
      const [old] = await this.db
        .select({ current: doctorProfiles.slug, published: doctorProfiles.publishedVersionId })
        .from(doctorProfileSlugs)
        .innerJoin(doctorProfiles, eq(doctorProfiles.id, doctorProfileSlugs.profileId))
        .where(eq(doctorProfileSlugs.slug, slug));
      return old?.published ? { redirect: old.current } : null;
    }
    if (!profile.publishedVersionId) return null;
    const version = await this.versionById(this.db, profile.publishedVersionId);
    const [doctor] = await this.db.select().from(doctors).where(eq(doctors.id, profile.doctorId));
    if (!version || !doctor || doctor.deletedAt) return null;
    const content = version.content as ProfileContent;

    const places = await this.db.execute(sql`
      SELECT w.id, b.name AS branch_name, b.address
      FROM doctor_workplaces w
      LEFT JOIN branches b ON b.id = w.branch_id
      WHERE w.doctor_id = ${doctor.id} AND w.deleted_at IS NULL
      ORDER BY w.created_at
    `);
    const now = new Date();
    const workplaces = [];
    let fields: { code: string; name: string }[] = [];
    for (const place of places.rows) {
      const part = await this.searchIndex.catalogPart(this.db, String(place['id']), now);
      if (!part?.listed) continue;
      fields = part.treatmentFields;
      workplaces.push({
        workplaceId: part.workplaceId,
        placeName: part.placeName,
        branchName: (place['branch_name'] as string | null) ?? null,
        address: (place['address'] as string | null) ?? null,
        cityCode: part.cityCode,
        services: part.prices.map((p) => ({
          serviceCode: p.serviceCode,
          serviceName: p.serviceCode,
          isFree: p.isFree,
          minRial: p.minRial.toString(),
          maxRial: p.maxRial.toString(),
        })),
      });
    }
    // The services' names, for the page (codes are for machines).
    const codes = [...new Set(workplaces.flatMap((w) => w.services.map((x) => x.serviceCode)))];
    const serviceNames = new Map<string, string>();
    if (codes.length > 0) {
      const { rows } = await this.db.execute(
        sql`SELECT code, name FROM services WHERE deleted_at IS NULL AND code IN ${codes}`,
      );
      for (const r of rows) serviceNames.set(String(r['code']), String(r['name']));
    }
    for (const w of workplaces) {
      for (const x of w.services) x.serviceName = serviceNames.get(x.serviceCode) ?? x.serviceCode;
    }
    return {
      profile: {
        slug: profile.slug,
        // Not `doctorName`: that name is the treatment field class of doc 04 §4.
        doctor: { id: doctor.id, name: doctor.name },
        medicalCouncilNumber: doctor.medicalCouncilNumber,
        treatmentFields: fields,
        specialtyTitle: content.specialtyTitle ?? null,
        biography: content.biography ?? null,
        history: content.history ?? [],
        socials: content.socials ?? [],
        photo: await this.publicMedia(content.photoAssetId ?? null),
        video:
          content.video?.hosting === 'aparat'
            ? { hosting: 'aparat', aparatId: content.video.aparatId }
            : content.video?.hosting === 'self'
              ? { hosting: 'self', ...(await this.publicMedia(content.video.assetId)) }
              : null,
        workplaces,
        withSepehrSince: profile.firstPublishedAt?.toISOString() ?? null,
        publishedAt: version.decidedAt?.toISOString() ?? null,
        indexable: workplaces.length > 0,
      },
    };
  }

  /**
   * Task 8-3: every published profile's address, for the sitemap (`indexableOnly`) and the
   * WordPress link list (all, with the flag). Indexable as the page decides it: published and
   * with a listed workplace, by the same rule as the search index's `listed` (the workplace
   * and the doctor not removed, its center active), read live. Public data only.
   */
  async publishedLinks(indexableOnly: boolean): Promise<PublishedProfileLink[]> {
    const { rows } = await this.db.execute(sql`
      SELECT p.slug, d.name, v.decided_at,
        EXISTS (
          SELECT 1 FROM doctor_workplaces w LEFT JOIN centers c ON c.id = w.center_id
          WHERE w.doctor_id = p.doctor_id AND w.deleted_at IS NULL
            AND (w.center_id IS NULL OR c.status = 'active')
        ) AS indexable
      FROM doctor_profiles p
      JOIN doctor_profile_versions v ON v.id = p.published_version_id
      JOIN doctors d ON d.id = p.doctor_id AND d.deleted_at IS NULL
      WHERE p.deleted_at IS NULL AND p.published_version_id IS NOT NULL
      ORDER BY p.slug
    `);
    return rows
      .map((r) => ({
        slug: String(r['slug']),
        name: String(r['name']),
        indexable: r['indexable'] === true,
        lastModified:
          r['decided_at'] === null ? null : new Date(r['decided_at'] as string).toISOString(),
      }))
      .filter((l) => !indexableOnly || l.indexable);
  }

  /**
   * One workplace as the public may see it (task 2-11, the booking page): the doctor, the
   * place, the treatment fields and the services with their prices and names; the address
   * of the doctor's published profile, if any. Only a listed workplace (it takes new
   * appointments); anything else is not found. All of it is shown by search already.
   */
  async publicWorkplace(workplaceId: string, now = new Date()) {
    const part = await this.searchIndex.catalogPart(this.db, workplaceId, now);
    if (!part?.listed) return null;
    const { rows } = await this.db.execute(sql`
      SELECT b.name AS branch_name, b.address, p.slug
      FROM doctor_workplaces w
      LEFT JOIN branches b ON b.id = w.branch_id
      LEFT JOIN doctor_profiles p ON p.doctor_id = w.doctor_id AND p.published_version_id IS NOT NULL
      WHERE w.id = ${workplaceId}
    `);
    const place = rows[0] ?? {};
    const codes = part.prices.map((p) => p.serviceCode);
    const names = new Map<string, string>();
    if (codes.length > 0) {
      const found = await this.db.execute(
        sql`SELECT code, name FROM services WHERE deleted_at IS NULL AND code IN ${codes}`,
      );
      for (const r of found.rows) names.set(String(r['code']), String(r['name']));
    }
    return {
      workplaceId: part.workplaceId,
      doctor: { id: part.doctorId, name: part.doctorName },
      profileSlug: (place['slug'] as string | null | undefined) ?? null,
      placeName: part.placeName,
      branchName: (place['branch_name'] as string | null | undefined) ?? null,
      address: (place['address'] as string | null | undefined) ?? null,
      cityCode: part.cityCode,
      treatmentFields: part.treatmentFields,
      creditEnabled: part.creditEnabled,
      services: part.prices.map((p) => ({
        serviceCode: p.serviceCode,
        serviceName: names.get(p.serviceCode) ?? p.serviceCode,
        isVisit: p.isVisit,
        isFree: p.isFree,
        minRial: p.minRial.toString(),
        maxRial: p.maxRial.toString(),
      })),
    };
  }

  // --- helpers --------------------------------------------------------------------------

  /** A published file's public variants; nothing until the worker has made them public. */
  private async publicMedia(assetId: string | null) {
    if (assetId === null) return null;
    const [asset] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    if (!asset?.publishedAt || asset.status !== 'ready') return null;
    return {
      variants: (asset.variants ?? []).map((v) => ({
        mime: v.mime,
        ...(v.width === undefined ? {} : { width: v.width }),
        url: this.storage.publicUrl(v.key),
      })),
    };
  }

  /** Files a draft shows must be the doctor's own, of the right kind, and not refused. */
  private async requireMedia(tx: Tx, doctorId: string, content: ProfileContent) {
    const wanted: { id: string; kind: 'image' | 'video' }[] = [];
    if (content.photoAssetId) wanted.push({ id: content.photoAssetId, kind: 'image' });
    if (content.video?.hosting === 'self')
      wanted.push({ id: content.video.assetId, kind: 'video' });
    if (content.video) {
      const hosting = (await this.config.resolve('catalog.profile_video_hosting')).value;
      if (content.video.hosting !== hosting) {
        throw new BadRequestException({ error: 'video_hosting_mismatch', hosting });
      }
    }
    for (const { id, kind } of wanted) {
      const [asset] = await tx
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.doctorId, doctorId)));
      if (!asset || asset.kind !== kind || asset.status === 'rejected') {
        throw new BadRequestException({ error: 'media_not_usable', assetId: id });
      }
    }
  }

  private async profileOf(tx: Tx, doctorId: string, lock = false): Promise<ProfileRow> {
    const query = tx.select().from(doctorProfiles).where(eq(doctorProfiles.doctorId, doctorId));
    const [profile] = lock ? await query.for('update') : await query;
    if (!profile) throw new NotFoundException({ error: 'profile_not_found' });
    return profile;
  }

  private async openVersion(tx: Tx, profileId: string): Promise<VersionRow | undefined> {
    const [row] = await tx
      .select()
      .from(doctorProfileVersions)
      .where(
        and(
          eq(doctorProfileVersions.profileId, profileId),
          inArray(doctorProfileVersions.status, ['draft', 'in_review']),
        ),
      )
      .for('update');
    return row;
  }

  private async versionById(ex: Tx | Database, id: string): Promise<VersionRow | undefined> {
    const [row] = await ex
      .select()
      .from(doctorProfileVersions)
      .where(eq(doctorProfileVersions.id, id));
    return row;
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }

  /** A slug or profile already taken becomes a clear 409. */
  private async unique<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const pg = pgCode(error);
      if (pg?.code === '23505') {
        if (pg.constraint?.includes('slug')) throw new ConflictException({ error: 'slug_taken' });
        if (pg.constraint === 'doctor_profiles_doctor_id_key') {
          throw new ConflictException({ error: 'profile_exists' });
        }
      }
      throw error;
    }
  }
}
