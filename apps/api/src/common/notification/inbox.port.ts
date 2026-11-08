import type { PermissionCode } from '@sepehr/contracts';
import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the notification module's bell (owner 1405/08/10): a notification in an account's
 * own list. The text is generic, with a link to the page; never an amount, a national ID or an
 * account number. The same `dedupeKey` notifies an account once.
 */
export interface InboxNotice {
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  /** A path of the account's own site (the panel's, or the patient's). */
  readonly linkHref: string | null;
  readonly dedupeKey: string;
}

export interface InboxPort {
  notifyAccounts(
    accountIds: readonly string[],
    notice: InboxNotice,
    tx?: SqlExecutor,
  ): Promise<void>;
  /** Everyone holding the permission now, through any live role. */
  notifyHolders(permission: PermissionCode, notice: InboxNotice, tx?: SqlExecutor): Promise<void>;
}

export const INBOX = Symbol('INBOX');
