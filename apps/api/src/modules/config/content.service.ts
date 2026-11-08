import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MAX_ACTIVE_BANNERS,
  type AnnouncementView,
  type BannerAudience,
  type BannerView,
  type ContentBlock,
  type ContentSlug,
  type DeskBanner,
  type PageView,
  type PublicPage,
  type announcementProposalSchema,
  type bannerProposalSchema,
  type pageProposalSchema,
} from '@sepehr/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import type { EffectiveAccess } from '../../common/auth/access.port';
import type { AnnouncementsPort, LiveAnnouncement } from '../../common/config/announcements.port';
import { INBOX, type InboxPort } from '../../common/notification/inbox.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';
import { scannerUnavailable } from '../../infra/clamd';
import { detectFileType } from '../../infra/file-type';
import { storageUnavailable } from '../../infra/s3-storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BANNER_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

type Table = 'dashboard_banners' | 'content_pages' | 'announcements';
type Row = Record<string, unknown>;
const iso = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v as string).toISOString();
const str = (v: unknown) => (v === null || v === undefined ? null : (v as string));

/** Which announcement audiences reach a viewer. */
function announcementAudiences(kind: 'patient' | 'staff' | 'center'): string[] {
  if (kind === 'patient') return ['all', 'patients'];
  if (kind === 'center') return ['all', 'centers'];
  return ['all', 'staff'];
}

/**
 * The portal's content (owner 1405/08/10; migration 0110): the desk's banners, the text pages
 * and the announcements. Each change is a new version, proposed by the system admin and decided
 * by another person (`config.propose_content`, `config.approve_content`); what was proposed never
 * changes (the database refuses it), and every step is audited. The version in force is the
 * newest approved one; at most {@link MAX_ACTIVE_BANNERS} banners run at once for an audience.
 */
@Injectable()
export class ContentService implements AnnouncementsPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(INBOX) private readonly inbox: InboxPort,
  ) {}

  private needPropose(access: EffectiveAccess) {
    if (!access.permissions.has('config.propose_content')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
  }

  private needDecide(access: EffectiveAccess) {
    if (!access.permissions.has('config.approve_content')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
  }

  private needRead(access: EffectiveAccess) {
    if (
      !access.permissions.has('config.propose_content') &&
      !access.permissions.has('config.approve_content')
    ) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
  }

  /** The next version of a key, under a lock on the key, in the caller's transaction. */
  private async nextVersion(
    tx: { execute: Database['execute'] },
    table: Table,
    keyColumn: string,
    key: string,
  ): Promise<number> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${table}:${key}`}))`);
    const rows = await tx.execute(
      sql`SELECT coalesce(max(version), 0) + 1 AS v FROM ${sql.raw(table)}
          WHERE ${sql.raw(keyColumn)} = ${key}`,
    );
    return Number(rows.rows[0]?.['v'] ?? 1);
  }

  private async tellApprovers(
    tx: { execute: Database['execute'] },
    what: string,
    id: string,
    link: string,
  ) {
    await this.inbox.notifyHolders(
      'config.approve_content',
      {
        kind: 'content.proposed',
        title: 'محتوای پیشخوان منتظر تأیید نفر دوم',
        body: `${what} پیشنهاد شده و تأیید شما را می‌خواهد.`,
        linkHref: link,
        dedupeKey: `content.proposed:${id}`,
      },
      tx,
    );
  }

  /** Approves or rejects a pending version; never its proposer's own. */
  private async decide(
    actor: Actor,
    access: EffectiveAccess,
    table: Table,
    id: string,
    approve: boolean,
    reason: string | undefined,
    check?: (tx: { execute: Database['execute'] }, row: Row) => Promise<void>,
    now = new Date(),
  ): Promise<Row> {
    this.needDecide(access);
    if (!UUID.test(id)) throw new NotFoundException({ error: 'version_not_found' });
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.execute(sql`SELECT * FROM ${sql.raw(table)} WHERE id = ${id} FOR UPDATE`)
      ).rows[0];
      if (!row) throw new NotFoundException({ error: 'version_not_found' });
      if (row['status'] !== 'pending') throw new ConflictException({ error: 'version_decided' });
      if (row['proposed_by'] === actor.accountId) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }
      if (!approve && !reason) throw new BadRequestException({ error: 'reason_required' });
      if (approve && check) await check(tx, row);
      const status = approve ? 'approved' : 'rejected';
      const updated = (
        await tx.execute(sql`
          UPDATE ${sql.raw(table)} SET status = ${status}, decided_by = ${actor.accountId},
            decided_at = ${now.toISOString()}, decision_reason = ${reason ?? null}
          WHERE id = ${id} RETURNING *
        `)
      ).rows[0] as Row;
      await this.audit.record(
        {
          actor,
          action: `config.content_${approve ? 'approved' : 'rejected'}`,
          entityType: table,
          entityId: id,
          before: { status: 'pending' },
          after: { status },
          reason: reason ?? null,
        },
        tx,
      );
      return updated;
    });
  }

  // --- banners ------------------------------------------------------------------------

  private bannerView(r: Row): BannerView {
    return {
      id: r['id'] as string,
      bannerKey: r['banner_key'] as string,
      version: Number(r['version']),
      status: r['status'] as BannerView['status'],
      reason: r['reason'] as string,
      proposedBy: r['proposed_by'] as string,
      decidedBy: str(r['decided_by']),
      decidedAt: iso(r['decided_at']),
      decisionReason: str(r['decision_reason']),
      createdAt: iso(r['created_at']) ?? '',
      title: r['title'] as string,
      body: r['body'] as string,
      tone: r['tone'] as BannerView['tone'],
      hasImage: r['image_key'] !== null,
      linkHref: str(r['link_href']),
      linkLabel: str(r['link_label']),
      sortOrder: Number(r['sort_order']),
      startsAt: iso(r['starts_at']) ?? '',
      endsAt: iso(r['ends_at']),
      audiences: r['audiences'] as BannerView['audiences'],
      active: Boolean(r['active']),
      displaySeconds: Number(r['display_seconds']),
    };
  }

  async banners(access: EffectiveAccess): Promise<BannerView[]> {
    this.needRead(access);
    const rows = await this.db.execute(sql`
      SELECT * FROM dashboard_banners ORDER BY banner_key, version DESC LIMIT 500
    `);
    return rows.rows.map((r) => this.bannerView(r));
  }

  async proposeBanner(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof bannerProposalSchema>,
    image: Buffer | null,
    now = new Date(),
  ): Promise<BannerView> {
    this.needPropose(access);
    if ((input.linkHref === null) !== (input.linkLabel === null)) {
      throw new BadRequestException({ error: 'link_and_label_together' });
    }
    if (input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new BadRequestException({ error: 'ends_before_start' });
    }
    let picture: { key: string; mime: string } | null = null;
    const key = input.bannerKey ?? (await this.newId());
    if (image) {
      if (image.length > BANNER_IMAGE_MAX_BYTES)
        throw new BadRequestException({ error: 'file_too_large' });
      if (!this.storage.configured) throw storageUnavailable();
      if (!this.scanner.configured) throw scannerUnavailable();
      const scan = await this.scanner.scan(image);
      if (!scan.clean) throw new BadRequestException({ error: 'file_infected' });
      const type = detectFileType(image);
      if (type?.kind !== 'image') throw new BadRequestException({ error: 'unsupported_type' });
      picture = { key: `banners/${key}/${await this.newId()}`, mime: type.mime };
      await this.storage.put('private', picture.key, image, type.mime);
    }
    return this.db.transaction(async (tx) => {
      if (input.bannerKey) {
        const exists = await tx.execute(
          sql`SELECT 1 FROM dashboard_banners WHERE banner_key = ${key} LIMIT 1`,
        );
        if (exists.rows.length === 0) throw new NotFoundException({ error: 'banner_not_found' });
      }
      // A new version without a new picture keeps the one in force.
      if (!picture && input.bannerKey) {
        const prev = (
          await tx.execute(sql`
            SELECT image_key, image_type FROM dashboard_banners
            WHERE banner_key = ${key} AND status = 'approved' ORDER BY version DESC LIMIT 1
          `)
        ).rows[0];
        if (prev?.['image_key']) {
          picture = { key: prev['image_key'] as string, mime: prev['image_type'] as string };
        }
      }
      const version = await this.nextVersion(tx, 'dashboard_banners', 'banner_key', key);
      const row = (
        await tx.execute(sql`
          INSERT INTO dashboard_banners (banner_key, version, title, body, tone, image_key,
            image_type, link_href, link_label, sort_order, starts_at, ends_at, audiences, active,
            display_seconds, reason, proposed_by, created_at)
          VALUES (${key}, ${version}, ${input.title}, ${input.body}, ${input.tone},
            ${picture?.key ?? null}, ${picture?.mime ?? null}, ${input.linkHref},
            ${input.linkLabel}, ${input.sortOrder}, ${input.startsAt}, ${input.endsAt},
            ${`{${input.audiences.join(',')}}`}::text[], ${input.active}, ${input.displaySeconds},
            ${input.reason}, ${actor.accountId}, ${now.toISOString()})
          RETURNING *
        `)
      ).rows[0] as Row;
      await this.audit.record(
        {
          actor,
          action: 'config.banner_proposed',
          entityType: 'dashboard_banners',
          entityId: row['id'] as string,
          after: { bannerKey: key, version, title: input.title, active: input.active },
          reason: input.reason,
        },
        tx,
      );
      await this.tellApprovers(tx, `بنر «${input.title}»`, row['id'] as string, '/content/banners');
      return this.bannerView(row);
    });
  }

  async decideBanner(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    approve: boolean,
    reason?: string,
    now = new Date(),
  ): Promise<BannerView> {
    const row = await this.decide(
      actor,
      access,
      'dashboard_banners',
      id,
      approve,
      reason,
      async (tx, r) => {
        if (!r['active']) return;
        // The banners running once this one is in force, per audience: at most five.
        for (const audience of r['audiences'] as string[]) {
          const n = await tx.execute(sql`
          SELECT count(*)::int AS n FROM (
            SELECT DISTINCT ON (banner_key) banner_key, active, ends_at, audiences
            FROM dashboard_banners WHERE status = 'approved' AND banner_key <> ${r['banner_key'] as string}
            ORDER BY banner_key, version DESC
          ) cur
          WHERE active AND (ends_at IS NULL OR ends_at > ${now.toISOString()})
            AND ${audience} = ANY (audiences)
        `);
          if (Number(n.rows[0]?.['n'] ?? 0) >= MAX_ACTIVE_BANNERS) {
            throw new ConflictException({ error: 'too_many_active_banners', audience });
          }
        }
      },
      now,
    );
    return this.bannerView(row);
  }

  /**
   * A version's picture, as bytes through the API (so the page needs no other origin): any
   * version for who manages the content; only an approved one for everyone else.
   */
  async bannerImage(
    id: string,
    access: EffectiveAccess | null,
  ): Promise<{ body: Buffer; contentType: string }> {
    if (access) this.needRead(access);
    if (!UUID.test(id)) throw new NotFoundException({ error: 'image_not_found' });
    const row = (
      await this.db.execute(sql`
        SELECT image_key, image_type FROM dashboard_banners
        WHERE id = ${id} ${access ? sql`` : sql`AND status = 'approved'`}
      `)
    ).rows[0];
    if (!row?.['image_key']) throw new NotFoundException({ error: 'image_not_found' });
    if (!this.storage.configured) throw storageUnavailable();
    return {
      body: await this.storage.get('private', row['image_key'] as string),
      contentType: row['image_type'] as string,
    };
  }

  /** The banners a desk shows now: in force, active, in their window, for this audience. */
  async deskBanners(audience: BannerAudience, now = new Date()): Promise<DeskBanner[]> {
    const rows = await this.db.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (banner_key) * FROM dashboard_banners
        WHERE status = 'approved' ORDER BY banner_key, version DESC
      ) cur
      WHERE active AND starts_at <= ${now.toISOString()}
        AND (ends_at IS NULL OR ends_at > ${now.toISOString()})
        AND ${audience} = ANY (audiences)
      ORDER BY sort_order, starts_at DESC
      LIMIT ${MAX_ACTIVE_BANNERS}
    `);
    return rows.rows.map((r) => ({
      bannerKey: r['banner_key'] as string,
      title: r['title'] as string,
      body: r['body'] as string,
      tone: r['tone'] as DeskBanner['tone'],
      imageUrl: r['image_key'] ? `/api/v1/config/banners/${r['id'] as string}/image` : null,
      linkHref: str(r['link_href']),
      linkLabel: str(r['link_label']),
      displaySeconds: Number(r['display_seconds']),
    }));
  }

  private async newId(): Promise<string> {
    return (await this.db.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
  }

  // --- text pages ---------------------------------------------------------------------

  private pageView(r: Row): PageView {
    return {
      id: r['id'] as string,
      version: Number(r['version']),
      status: r['status'] as PageView['status'],
      reason: r['reason'] as string,
      proposedBy: r['proposed_by'] as string,
      decidedBy: str(r['decided_by']),
      decidedAt: iso(r['decided_at']),
      decisionReason: str(r['decision_reason']),
      createdAt: iso(r['created_at']) ?? '',
      slug: r['slug'] as ContentSlug,
      title: r['title'] as string,
      blocks: r['body'] as ContentBlock[],
    };
  }

  async pages(access: EffectiveAccess, slug?: ContentSlug): Promise<PageView[]> {
    this.needRead(access);
    const rows = await this.db.execute(sql`
      SELECT * FROM content_pages ${slug ? sql`WHERE slug = ${slug}` : sql``}
      ORDER BY slug, version DESC LIMIT 500
    `);
    return rows.rows.map((r) => this.pageView(r));
  }

  async proposePage(
    actor: Actor,
    access: EffectiveAccess,
    slug: ContentSlug,
    input: z.output<typeof pageProposalSchema>,
    now = new Date(),
  ): Promise<PageView> {
    this.needPropose(access);
    return this.db.transaction(async (tx) => {
      const version = await this.nextVersion(tx, 'content_pages', 'slug', slug);
      const row = (
        await tx.execute(sql`
          INSERT INTO content_pages (slug, version, title, body, reason, proposed_by, created_at)
          VALUES (${slug}, ${version}, ${input.title}, ${JSON.stringify(input.blocks)}::jsonb,
            ${input.reason}, ${actor.accountId}, ${now.toISOString()})
          RETURNING *
        `)
      ).rows[0] as Row;
      await this.audit.record(
        {
          actor,
          action: 'config.page_proposed',
          entityType: 'content_pages',
          entityId: row['id'] as string,
          after: { slug, version, title: input.title, blocks: input.blocks.length },
          reason: input.reason,
        },
        tx,
      );
      await this.tellApprovers(
        tx,
        `صفحه «${input.title}»`,
        row['id'] as string,
        `/content/pages/${slug}`,
      );
      return this.pageView(row);
    });
  }

  async decidePage(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    approve: boolean,
    reason?: string,
  ) {
    return this.pageView(await this.decide(actor, access, 'content_pages', id, approve, reason));
  }

  /** A page as the public reads it: the newest approved version, or 404. */
  async publicPage(slug: ContentSlug): Promise<PublicPage> {
    const r = (
      await this.db.execute(sql`
        SELECT slug, title, body, version, decided_at FROM content_pages
        WHERE slug = ${slug} AND status = 'approved' ORDER BY version DESC LIMIT 1
      `)
    ).rows[0];
    if (!r) throw new NotFoundException({ error: 'page_not_found' });
    return {
      slug: r['slug'] as ContentSlug,
      title: r['title'] as string,
      blocks: r['body'] as ContentBlock[],
      version: Number(r['version']),
      updatedAt: iso(r['decided_at']) ?? new Date().toISOString(),
    };
  }

  // --- announcements --------------------------------------------------------------------

  private announcementView(r: Row): AnnouncementView {
    return {
      id: r['id'] as string,
      version: Number(r['version']),
      status: r['status'] as AnnouncementView['status'],
      reason: r['reason'] as string,
      proposedBy: r['proposed_by'] as string,
      decidedBy: str(r['decided_by']),
      decidedAt: iso(r['decided_at']),
      decisionReason: str(r['decision_reason']),
      createdAt: iso(r['created_at']) ?? '',
      announcementKey: r['announcement_key'] as string,
      title: r['title'] as string,
      body: r['body'] as string,
      audience: r['audience'] as AnnouncementView['audience'],
      roleCode: str(r['role_code']),
      urgent: Boolean(r['urgent']),
      startsAt: iso(r['starts_at']) ?? '',
      endsAt: iso(r['ends_at']),
      active: Boolean(r['active']),
    };
  }

  async announcements(access: EffectiveAccess): Promise<AnnouncementView[]> {
    this.needRead(access);
    const rows = await this.db.execute(sql`
      SELECT * FROM announcements ORDER BY announcement_key, version DESC LIMIT 500
    `);
    return rows.rows.map((r) => this.announcementView(r));
  }

  async proposeAnnouncement(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof announcementProposalSchema>,
    now = new Date(),
  ): Promise<AnnouncementView> {
    this.needPropose(access);
    if (input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new BadRequestException({ error: 'ends_before_start' });
    }
    const key = input.announcementKey ?? (await this.newId());
    return this.db.transaction(async (tx) => {
      // A role audience names a role code; an unknown one simply reaches nobody (the roles
      // are the access module's, never read here).
      if (input.announcementKey) {
        const exists = await tx.execute(
          sql`SELECT 1 FROM announcements WHERE announcement_key = ${key} LIMIT 1`,
        );
        if (exists.rows.length === 0)
          throw new NotFoundException({ error: 'announcement_not_found' });
      }
      const version = await this.nextVersion(tx, 'announcements', 'announcement_key', key);
      const row = (
        await tx.execute(sql`
          INSERT INTO announcements (announcement_key, version, title, body, audience, role_code,
            urgent, starts_at, ends_at, active, reason, proposed_by, created_at)
          VALUES (${key}, ${version}, ${input.title}, ${input.body}, ${input.audience},
            ${input.roleCode}, ${input.urgent}, ${input.startsAt}, ${input.endsAt},
            ${input.active}, ${input.reason}, ${actor.accountId}, ${now.toISOString()})
          RETURNING *
        `)
      ).rows[0] as Row;
      await this.audit.record(
        {
          actor,
          action: 'config.announcement_proposed',
          entityType: 'announcements',
          entityId: row['id'] as string,
          after: { announcementKey: key, version, title: input.title, audience: input.audience },
          reason: input.reason,
        },
        tx,
      );
      await this.tellApprovers(
        tx,
        `اطلاعیه «${input.title}»`,
        row['id'] as string,
        '/content/announcements',
      );
      return this.announcementView(row);
    });
  }

  async decideAnnouncement(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    approve: boolean,
    reason?: string,
  ) {
    return this.announcementView(
      await this.decide(actor, access, 'announcements', id, approve, reason),
    );
  }

  /** ANNOUNCEMENTS: those in force now for this viewer. Read by the bell. */
  async liveFor(
    viewer: { kind: 'patient' | 'staff' | 'center'; roles: readonly string[] },
    now = new Date(),
  ): Promise<LiveAnnouncement[]> {
    const audiences = announcementAudiences(viewer.kind);
    const roleMatch: SQL =
      viewer.kind === 'patient' || viewer.roles.length === 0
        ? sql`false`
        : sql`(audience = 'role' AND role_code = ANY (${`{${viewer.roles.join(',')}}`}::text[]))`;
    const rows = await this.db.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (announcement_key) * FROM announcements
        WHERE status = 'approved' ORDER BY announcement_key, version DESC
      ) cur
      WHERE active AND starts_at <= ${now.toISOString()}
        AND (ends_at IS NULL OR ends_at > ${now.toISOString()})
        AND (audience = ANY (${`{${audiences.join(',')}}`}::text[]) OR ${roleMatch})
      ORDER BY urgent DESC, starts_at DESC LIMIT 50
    `);
    return rows.rows.map((r) => ({
      announcementKey: r['announcement_key'] as string,
      title: r['title'] as string,
      body: r['body'] as string,
      urgent: Boolean(r['urgent']),
      startsAt: new Date(r['starts_at'] as string),
    }));
  }
}
