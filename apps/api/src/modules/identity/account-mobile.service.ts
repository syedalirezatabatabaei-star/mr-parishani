import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FINANCIAL_SIGNING_PERMISSIONS, type AccountMobileView } from '@sepehr/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { ACCESS_PORT, type AccessPort } from '../../common/auth/access.port';
import { DATABASE, type Database } from '../../db/database.module';
import { FactorNotices } from './factor-notices';
import { userAccounts } from './identity.schema';
import { OtpChallengeService } from './otp-challenge.service';

/** Kept apart from login and consent codes: a mobile code proves only the mobile. */
const PURPOSE = 'account_mobile';

/**
 * A staff or center user's own mobile, proved with a code sent to it (task 4-6; owner
 * 1405/07/12: verified by OTP, never only typed). Doctors and center managers need one to
 * be linked or granted (the access module checks), and to be told of funded patients.
 * The same code delivery, expiry, cooldown and lockout as the login code. Nobody sets
 * another person's mobile; a patient's mobile is their login and is not changed here.
 */
@Injectable()
export class AccountMobileService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly challenge: OtpChallengeService,
    private readonly notices: FactorNotices,
    @Inject(ACCESS_PORT) private readonly access: AccessPort,
  ) {}

  /**
   * ADR-052 (owner 1405/08/02, 1405/08/03): a staff member's verified mobile is where their
   * financial codes go. Replacing it takes two others (StaffMobileChangeService), never its
   * owner; and a financial signer's first number too (the «شماره امضاکنندگان» page; the
   * approvers' own first numbers on the server). The same number proved again, and the first
   * mobile of staff who sign nothing, are still their own; so is a center account's.
   */
  private async notReplacingSigner(
    accountId: string,
    account: { kind: string; mobile: string | null; mobileVerifiedAt: Date | null },
    mobile: string,
  ) {
    if (account.kind !== 'staff') return;
    if (account.mobileVerifiedAt !== null && account.mobile !== null) {
      if (account.mobile !== mobile) {
        throw new ConflictException({ error: 'mobile_change_needs_approval' });
      }
      return;
    }
    const { permissions } = await this.access.resolve(accountId);
    if (FINANCIAL_SIGNING_PERMISSIONS.some((p) => permissions.has(p))) {
      throw new ConflictException({ error: 'signer_mobile_needs_approval' });
    }
  }

  async view(accountId: string): Promise<AccountMobileView> {
    const row = await this.staffAccount(accountId);
    return {
      mobileLastFour: row.mobile?.slice(-4) ?? null,
      verified: row.mobile !== null && row.mobileVerifiedAt !== null,
      verifiedAt: row.mobileVerifiedAt?.toISOString() ?? null,
    };
  }

  async request(actor: Actor, accountId: string, mobile: string) {
    await this.notReplacingSigner(accountId, await this.staffAccount(accountId), mobile);
    return this.challenge.send(mobile, PURPOSE, { ip: actor.ip });
  }

  async verify(
    actor: Actor,
    accountId: string,
    mobile: string,
    code: string,
  ): Promise<AccountMobileView> {
    const before = await this.staffAccount(accountId);
    await this.notReplacingSigner(accountId, before, mobile);
    // A wrong code counts toward the lockout and changes nothing.
    await this.challenge.verify(mobile, PURPOSE, code, { ip: actor.ip });
    const now = new Date();
    await this.db.transaction(async (tx) => {
      // The mobile it replaces, read under lock: the one told of the change (task 9-3, R2).
      const [previous] = await tx
        .select({ mobile: userAccounts.mobile, mobileVerifiedAt: userAccounts.mobileVerifiedAt })
        .from(userAccounts)
        .where(eq(userAccounts.id, accountId))
        .for('update');
      await tx
        .update(userAccounts)
        .set({ mobile, mobileVerifiedAt: now })
        .where(eq(userAccounts.id, accountId));
      // A first proved mobile, or the same one proved again, is no change to tell of.
      if (previous?.mobile && previous.mobileVerifiedAt !== null && previous.mobile !== mobile) {
        await this.notices.record(
          actor,
          { accountId, event: 'mobile_changed', mobile: previous.mobile },
          tx,
        );
      }
      await this.audit.record(
        {
          actor,
          action: 'identity.account_mobile_verified',
          entityType: 'user_account',
          entityId: accountId,
          // The last four digits only (rule 30: no personal data in the record's diff).
          before: {
            mobileLastFour: before.mobile?.slice(-4) ?? null,
            verified: before.mobileVerifiedAt !== null,
          },
          after: { mobileLastFour: mobile.slice(-4), verified: true },
        },
        tx,
      );
    });
    return this.view(accountId);
  }

  private async staffAccount(accountId: string) {
    const [row] = await this.db
      .select({
        kind: userAccounts.kind,
        mobile: userAccounts.mobile,
        mobileVerifiedAt: userAccounts.mobileVerifiedAt,
      })
      .from(userAccounts)
      .where(and(eq(userAccounts.id, accountId), isNull(userAccounts.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException({ error: 'account_not_found' });
    if (row.kind === 'patient') throw new ForbiddenException({ error: 'staff_or_center_only' });
    return row;
  }
}
