import type { PermissionCode } from '@sepehr/contracts';
import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the config module's notices for the system admin (task 2-1's table; task 4-6): a
 * notice open per code until resolved, shown to holders of its audience permission
 * (`GET /config/notices`). Messages hold counts, never personal data (rule 30).
 */
export interface AdminNotices {
  /** Opens the notice of `code`, or refreshes its message and count if it is open. */
  raise(
    code: string,
    audience: PermissionCode,
    message: string,
    now?: Date,
    tx?: SqlExecutor,
  ): Promise<void>;
  /** Closes the open notice of `code`, if any. */
  resolve(code: string, now?: Date, tx?: SqlExecutor): Promise<void>;
}

export const ADMIN_NOTICES = Symbol('ADMIN_NOTICES');
