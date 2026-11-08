import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizeMobile } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { ACCESS_PORT, type AccessPort } from '../../common/auth/access.port';
import { CLI_ACTOR } from '../../common/auth/actor';
import { AUDIT_LOG, type AuditLog } from '../../common/audit/audit.port';
import { DATABASE, type Database } from '../../db/database.module';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * ADR-052 (owner 1405/08/03): the first number of an approver of signers' mobiles (the CEO,
 * the system administrator, the third approver), who cannot be approved by the page they
 * approve on. Set on the server only, never through the API: the system administrator runs
 * the command and another person witnesses it (the owner; for the owner's own number, the
 * CEO), both checked as staff accounts and named in the audit trail. Only a first number: an
 * account with a verified mobile is refused, and every later change goes through two people.
 */
@Injectable()
export class FirstApproverMobile {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(ACCESS_PORT) private readonly access: AccessPort,
  ) {}

  async set(input: {
    username: string;
    mobile: string;
    operator: string;
    witness: string;
    reason: string;
  }): Promise<{ accountId: string; mobileLastFour: string }> {
    const mobile = normalizeMobile(input.mobile);
    if (!mobile) throw new ConflictException({ error: 'invalid_mobile' });
    for (const [name, value] of [
      ['operator', input.operator],
      ['witness', input.witness],
      ['reason', input.reason],
    ] as const) {
      if (value.trim().length < 3) throw new ConflictException({ error: `${name}_required` });
    }
    if (input.operator.trim() === input.witness.trim()) {
      throw new ConflictException({ error: 'witness_must_differ' });
    }
    return this.db.transaction(async (tx) => {
      const account = (
        await tx.execute(sql`
          SELECT id, kind, mobile_verified_at FROM user_accounts
          WHERE username = ${input.username} AND deleted_at IS NULL
          FOR UPDATE
        `)
      ).rows[0] as { id: string; kind: string; mobile_verified_at: Date | null } | undefined;
      if (!account || account.kind !== 'staff') {
        throw new NotFoundException({ error: 'account_not_found' });
      }
      const access = await this.access.resolve(account.id);
      if (!access.permissions.has('identity.approve_financial_mobile_change')) {
        throw new ForbiddenException({ error: 'approvers_only' });
      }
      // Owner 1405/08/03: the system administrator runs it; the witness is another person, never
      // the account's owner (for the owner's own number: the CEO). Both are real staff accounts.
      const operator = await this.staffNamed(tx, input.operator);
      const witness = await this.staffNamed(tx, input.witness);
      if (!operator || !(await this.access.resolve(operator)).roles.includes('system_admin')) {
        throw new ForbiddenException({ error: 'operator_must_be_system_admin' });
      }
      if (!witness) throw new ForbiddenException({ error: 'witness_not_found' });
      if (witness === account.id) throw new ForbiddenException({ error: 'witness_is_the_owner' });
      if (
        access.roles.includes('mobile_change_approver') &&
        !(await this.access.resolve(witness)).roles.includes('ceo')
      ) {
        throw new ForbiddenException({ error: 'witness_must_be_ceo' });
      }
      if (account.mobile_verified_at !== null) {
        throw new ConflictException({ error: 'mobile_already_verified' });
      }
      const taken = await tx.execute(sql`
        SELECT 1 FROM user_accounts
        WHERE mobile = ${mobile} AND kind = 'staff' AND mobile_verified_at IS NOT NULL
          AND deleted_at IS NULL AND id <> ${account.id}
      `);
      if (taken.rows.length > 0) throw new ConflictException({ error: 'mobile_taken' });
      await tx.execute(sql`
        UPDATE user_accounts SET mobile = ${mobile}, mobile_verified_at = now()
        WHERE id = ${account.id} AND mobile_verified_at IS NULL
      `);
      await this.audit.record(
        {
          actor: CLI_ACTOR,
          action: 'identity.first_approver_mobile_set',
          entityType: 'user_account',
          entityId: account.id,
          // The last four digits only (rule 30); who ran it and who watched, by username.
          after: {
            mobileLastFour: mobile.slice(-4),
            operator: input.operator.trim(),
            operatorAccountId: operator,
            witness: input.witness.trim(),
            witnessAccountId: witness,
          },
          reason: input.reason.trim(),
        },
        tx,
      );
      return { accountId: account.id, mobileLastFour: mobile.slice(-4) };
    });
  }

  private async staffNamed(tx: Tx, username: string): Promise<string | null> {
    const row = (
      await tx.execute(sql`
        SELECT id FROM user_accounts
        WHERE username = ${username.trim()} AND kind = 'staff' AND deleted_at IS NULL
          AND status = 'active'
      `)
    ).rows[0] as { id: string } | undefined;
    return row?.id ?? null;
  }
}
