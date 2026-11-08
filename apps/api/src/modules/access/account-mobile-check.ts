import { Inject, Injectable, Logger } from '@nestjs/common';
import { toPersianDigits } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { ADMIN_NOTICES, type AdminNotices } from '../../common/config/admin-notices.port';
import { DATABASE, type Database } from '../../db/database.module';

export const ACCOUNT_MOBILE_NOTICE = 'account_mobile_missing';

export interface AccountMobileResult {
  /** Linked doctor and center-manager accounts without a verified mobile. */
  readonly unverifiedAccounts: number;
  /** Doctor workplaces with no account at all: never told of a funded patient. */
  readonly doctorsWithoutAccount: number;
  readonly notice: 'raised' | 'resolved';
}

/**
 * Daily (task 4-6; owner 1405/07/12, technical task ف۴): the doctors and center managers
 * who would silently miss an SMS, because their account's mobile is missing or unproved,
 * or the doctor has no account. Grants and links made before the requirement are not
 * undone; the system admin sees a notice with the counts (no names: rule 30) until the
 * list is empty, which it must be before launch (task 10).
 */
@Injectable()
export class AccountMobileCheck {
  private readonly logger = new Logger(AccountMobileCheck.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(ADMIN_NOTICES) private readonly notices: AdminNotices,
  ) {}

  async run(now = new Date()): Promise<AccountMobileResult> {
    const { ids, withoutAccount } = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.rls_mode', 'system', true)`);
      const linked = await tx.execute(sql`
        SELECT DISTINCT account_id FROM org_nodes
        WHERE kind = 'doctor' AND account_id IS NOT NULL AND deleted_at IS NULL
        UNION
        SELECT DISTINCT a.account_id FROM role_assignments a
        JOIN roles r ON r.id = a.role_id
        WHERE r.code = 'center_manager' AND a.revoked_at IS NULL AND a.deleted_at IS NULL
      `);
      const missing = await tx.execute(sql`
        SELECT count(*)::int AS n FROM org_nodes
        WHERE kind = 'doctor' AND account_id IS NULL AND deleted_at IS NULL
      `);
      return {
        ids: linked.rows.map((r) => r['account_id'] as string),
        withoutAccount: Number(missing.rows[0]?.['n'] ?? 0),
      };
    });
    let unverified = 0;
    for (const id of ids) {
      const account = await this.accounts.find(id);
      if (account?.status === 'active' && !account.mobileVerified) unverified++;
    }
    if (unverified === 0 && withoutAccount === 0) {
      await this.notices.resolve(ACCOUNT_MOBILE_NOTICE, now);
      return { unverifiedAccounts: 0, doctorsWithoutAccount: 0, notice: 'resolved' };
    }
    const message =
      `${toPersianDigits(unverified)} حساب پزشک یا مدیر مرکز موبایل تأییدشده ندارد و ` +
      `${toPersianDigits(withoutAccount)} محل کار پزشک حساب کاربری ندارد؛ ` +
      'این افراد پیامک‌های سامانه (مثل «بیمار آماده است») را نمی‌گیرند.';
    await this.notices.raise(ACCOUNT_MOBILE_NOTICE, 'access.assign_roles', message, now);
    this.logger.warn(
      `accounts without a verified mobile: ${String(unverified)}; doctors without an account: ${String(withoutAccount)}`,
    );
    return {
      unverifiedAccounts: unverified,
      doctorsWithoutAccount: withoutAccount,
      notice: 'raised',
    };
  }
}
