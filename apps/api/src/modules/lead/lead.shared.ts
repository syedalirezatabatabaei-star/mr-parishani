import { ForbiddenException } from '@nestjs/common';
import type { PermissionCode } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import type { Actor } from '../../common/audit/audit.port';
import type { Database } from '../../db/database.module';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the lead module does on its own: linking an account, processing an import row. */
export const systemActor = (role: string): Actor => ({
  accountId: null,
  sessionId: null,
  ip: null,
  roles: [role],
});

/** Rule 12: checked in the service as well as by the guard. */
export function requirePermission(access: EffectiveAccess, permission: PermissionCode) {
  if (!access.permissions.has(permission)) {
    throw new ForbiddenException({ error: 'permission_required', permission });
  }
}

/** One writer at a time for this key, until the transaction ends. */
export async function lockKey(tx: Tx, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export const pgCode = (error: unknown): string | undefined => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
};
