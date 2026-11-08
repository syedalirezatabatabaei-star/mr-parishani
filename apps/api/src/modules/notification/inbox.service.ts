import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Inbox, InboxItem, PermissionCode } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { ACCESS_PORT, type AccessPort } from '../../common/auth/access.port';
import { ANNOUNCEMENTS, type AnnouncementsPort } from '../../common/config/announcements.port';
import type { InboxNotice, InboxPort } from '../../common/notification/inbox.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The newest notifications a bell lists; older ones stay recorded. */
const LIST_LIMIT = 50;
/** An announcement's id in the list, apart from a notification's. */
const ANNOUNCEMENT = 'a:';

export interface InboxViewer {
  readonly accountId: string;
  readonly kind: 'patient' | 'staff' | 'center';
  readonly roles: readonly string[];
}

/**
 * The bell (owner 1405/08/10; migration 0110): each account's own notifications, written by
 * the modules (INBOX) and by the domain events about it (InboxConsumer), with the
 * announcements in force for it (ANNOUNCEMENTS). Each is read by its own account only.
 */
@Injectable()
export class InboxService implements InboxPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // The access and config modules' ports, wherever they are provided (the API, the worker).
    private readonly moduleRef: ModuleRef,
  ) {}

  private get access(): AccessPort {
    return this.moduleRef.get<AccessPort>(ACCESS_PORT, { strict: false });
  }

  private get announcements(): AnnouncementsPort {
    return this.moduleRef.get<AnnouncementsPort>(ANNOUNCEMENTS, { strict: false });
  }

  async notifyAccounts(
    accountIds: readonly string[],
    notice: InboxNotice,
    tx?: SqlExecutor,
  ): Promise<void> {
    const ids = [...new Set(accountIds)].filter((id) => UUID.test(id));
    for (const accountId of ids) {
      await (tx ?? this.db).execute(sql`
        INSERT INTO inbox_notifications (account_id, kind, title, body, link_href, dedupe_key)
        VALUES (${accountId}, ${notice.kind}, ${notice.title}, ${notice.body},
          ${notice.linkHref}, ${notice.dedupeKey})
        ON CONFLICT (account_id, dedupe_key) DO NOTHING
      `);
    }
  }

  async notifyHolders(
    permission: PermissionCode,
    notice: InboxNotice,
    tx?: SqlExecutor,
  ): Promise<void> {
    await this.notifyAccounts(await this.access.holdersOfPermission(permission), notice, tx);
  }

  async list(viewer: InboxViewer, now = new Date()): Promise<Inbox> {
    const [rows, live, reads] = await Promise.all([
      this.db.execute(sql`
        SELECT id, kind, title, body, link_href, read_at, created_at FROM inbox_notifications
        WHERE account_id = ${viewer.accountId}
        ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}
      `),
      this.announcements.liveFor({ kind: viewer.kind, roles: viewer.roles }, now),
      this.db.execute(sql`
        SELECT announcement_key FROM announcement_reads WHERE account_id = ${viewer.accountId}
      `),
    ]);
    const readKeys = new Set(reads.rows.map((r) => r['announcement_key'] as string));
    const items: InboxItem[] = [
      ...live.map((a) => ({
        id: `${ANNOUNCEMENT}${a.announcementKey}`,
        source: 'announcement' as const,
        kind: a.urgent ? 'announcement.urgent' : 'announcement',
        title: a.title,
        body: a.body,
        linkHref: null,
        urgent: a.urgent,
        createdAt: a.startsAt.toISOString(),
        read: readKeys.has(a.announcementKey),
      })),
      ...rows.rows.map((r) => ({
        id: r['id'] as string,
        source: 'system' as const,
        kind: r['kind'] as string,
        title: r['title'] as string,
        body: r['body'] as string,
        linkHref: (r['link_href'] as string | null) ?? null,
        urgent: false,
        createdAt: new Date(r['created_at'] as string).toISOString(),
        read: r['read_at'] !== null,
      })),
    ];
    // Urgent announcements first, then the newest.
    items.sort(
      (a, b) =>
        Number(b.urgent && !b.read) - Number(a.urgent && !a.read) ||
        b.createdAt.localeCompare(a.createdAt),
    );
    const unreadSystem = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM inbox_notifications
      WHERE account_id = ${viewer.accountId} AND read_at IS NULL
    `);
    const unread =
      Number(unreadSystem.rows[0]?.['n'] ?? 0) +
      live.filter((a) => !readKeys.has(a.announcementKey)).length;
    return { items, unread };
  }

  /** Marks the viewer's own items read: these, or every one. */
  async markRead(
    viewer: InboxViewer,
    input: { all: true } | { ids: readonly string[] },
    now = new Date(),
  ): Promise<void> {
    const at = now.toISOString();
    if ('all' in input) {
      await this.db.execute(sql`
        UPDATE inbox_notifications SET read_at = ${at}
        WHERE account_id = ${viewer.accountId} AND read_at IS NULL
      `);
      const live = await this.announcements.liveFor(
        { kind: viewer.kind, roles: viewer.roles },
        now,
      );
      for (const a of live) await this.readAnnouncement(viewer.accountId, a.announcementKey);
      return;
    }
    for (const id of input.ids) {
      if (id.startsWith(ANNOUNCEMENT)) {
        const key = id.slice(ANNOUNCEMENT.length);
        if (UUID.test(key)) await this.readAnnouncement(viewer.accountId, key);
      } else if (UUID.test(id)) {
        await this.db.execute(sql`
          UPDATE inbox_notifications SET read_at = ${at}
          WHERE id = ${id} AND account_id = ${viewer.accountId} AND read_at IS NULL
        `);
      }
    }
  }

  private async readAnnouncement(accountId: string, key: string) {
    await this.db.execute(sql`
      INSERT INTO announcement_reads (account_id, announcement_key) VALUES (${accountId}, ${key})
      ON CONFLICT (account_id, announcement_key) DO NOTHING
    `);
  }
}
