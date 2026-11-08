import { Inject, Injectable } from '@nestjs/common';
import type { PermissionCode } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type { AdminNotices } from '../../common/config/admin-notices.port';
import { DATABASE, type Database } from '../../db/database.module';

/** ADMIN_NOTICES: one open notice per code (admin_notices_open_code_key). */
@Injectable()
export class AdminNoticeService implements AdminNotices {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async raise(
    code: string,
    audience: PermissionCode,
    message: string,
    now = new Date(),
    tx?: SqlExecutor,
  ): Promise<void> {
    await (tx ?? this.db).execute(sql`
      INSERT INTO admin_notices (code, audience_permission, message, first_raised_at, last_raised_at)
      VALUES (${code}, ${audience}, ${message}, ${now}, ${now})
      ON CONFLICT (code) WHERE resolved_at IS NULL AND deleted_at IS NULL
      DO UPDATE SET message = EXCLUDED.message, last_raised_at = EXCLUDED.last_raised_at,
                    raise_count = admin_notices.raise_count + 1
    `);
  }

  async resolve(code: string, now = new Date(), tx?: SqlExecutor): Promise<void> {
    await (tx ?? this.db).execute(sql`
      UPDATE admin_notices SET resolved_at = ${now}
      WHERE code = ${code} AND resolved_at IS NULL AND deleted_at IS NULL
    `);
  }
}
