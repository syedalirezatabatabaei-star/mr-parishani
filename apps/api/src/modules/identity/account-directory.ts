import { Inject, Injectable, Optional } from '@nestjs/common';
import { PERSON_DIRECTORY, type PersonDirectory } from '@sepehr/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  AccountDirectory,
  AccountSummary,
  StaffAccountSummary,
} from '../../common/auth/account-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import { userAccounts } from './identity.schema';

/**
 * The identity module's side of the ACCOUNT_DIRECTORY port.
 *
 * Task 9-3 (go-live blocker م۵): every patient path reaches the records of its Person through
 * `personId` here, so here a linked account whose mobile no longer stands for that Person (a
 * merge's re-issue of it pending, or refused) is given none. The link itself stays.
 */
@Injectable()
export class IdentityAccountDirectory implements AccountDirectory {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Optional() @Inject(PERSON_DIRECTORY) private readonly persons: PersonDirectory | null,
  ) {}

  async find(accountId: string): Promise<AccountSummary | null> {
    const [row] = await this.db
      .select({
        id: userAccounts.id,
        kind: userAccounts.kind,
        status: userAccounts.status,
        mobile: userAccounts.mobile,
        mobileVerifiedAt: userAccounts.mobileVerifiedAt,
        personId: userAccounts.personId,
      })
      .from(userAccounts)
      .where(and(eq(userAccounts.id, accountId), isNull(userAccounts.deletedAt)))
      .limit(1);
    if (!row) return null;
    const { mobileVerifiedAt, ...summary } = row;
    if (
      summary.kind === 'patient' &&
      summary.personId !== null &&
      summary.mobile !== null &&
      this.persons &&
      !(await this.persons.standsFor(summary.mobile, summary.personId))
    ) {
      summary.personId = null;
    }
    return {
      ...summary,
      mobileVerified: row.mobile !== null && (row.kind === 'patient' || mobileVerifiedAt !== null),
    };
  }

  async nameOf(accountId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ displayName: userAccounts.displayName, username: userAccounts.username })
      .from(userAccounts)
      .where(and(eq(userAccounts.id, accountId), isNull(userAccounts.deletedAt)))
      .limit(1);
    return row?.displayName ?? row?.username ?? null;
  }

  async findStaffByUsername(username: string): Promise<StaffAccountSummary | null> {
    const [row] = await this.db
      .select({
        id: userAccounts.id,
        username: userAccounts.username,
        displayName: userAccounts.displayName,
        kind: userAccounts.kind,
        status: userAccounts.status,
      })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.username, username.trim().toLowerCase()),
          inArray(userAccounts.kind, ['staff', 'center']),
          isNull(userAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!row?.username || row.kind === 'patient') return null;
    return { ...row, username: row.username, kind: row.kind };
  }

  async patientAccountsOf(
    personIds: readonly string[],
    mobiles: readonly string[],
  ): Promise<string[]> {
    if (personIds.length === 0 && mobiles.length === 0) return [];
    const rows = await this.db.execute(sql`
      SELECT id FROM user_accounts
      WHERE kind = 'patient' AND status = 'active' AND deleted_at IS NULL
        AND (person_id = ANY (${`{${personIds.join(',')}}`}::uuid[])
          OR mobile = ANY (${`{${mobiles.join(',')}}`}::text[]))
    `);
    return rows.rows.map((r) => r['id'] as string);
  }
}
