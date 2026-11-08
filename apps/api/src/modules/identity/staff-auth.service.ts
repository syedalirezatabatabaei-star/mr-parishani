import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthClient } from '@sepehr/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AuthContext } from '../../common/auth/auth.decorators';
import { DATABASE, type Database } from '../../db/database.module';
import { REDIS } from '../../infra/redis.module';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { FactorNotices } from './factor-notices';
import { sessions as sessionRows, totpResetRequests, userAccounts } from './identity.schema';
import { IDENTITY_SECRETS, type IdentitySecrets, type RequestMeta } from './identity.tokens';
import { tooManyRequests } from './otp-login.service';
import { dummyPasswordHash, hashPassword, verifyPassword, weakPasswordReason } from './password';
import { RateLimiter } from './rate-limiter';
import { SessionService, type IssuedSession } from './session.service';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

const TOTP_ISSUER = 'Sepehr Salamati';

/** FieldCrypto context: binds each encrypted secret to its column and account. */
export const totpContext = (accountId: string) =>
  `user_accounts.totp_secret_encrypted:${accountId}`;

/**
 * Wrong passwords and wrong TOTP codes count separately: a correct password clears only
 * its own counter, so it can never reset the count of TOTP guesses.
 */
type Factor = 'password' | 'totp';
const failureKey = (factor: Factor, username: string) =>
  factor === 'password' ? `staff:${username}` : `staff-totp:${username}`;

/**
 * Staff and center login (rule 25): argon2id password, then TOTP, which is mandatory. The
 * password alone only yields a `mfa_pending` session that can do nothing but enroll in or
 * pass TOTP; passing it replaces that session with a new one.
 */
@Injectable()
export class StaffAuthService {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) redis: Redis,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly notices: FactorNotices,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  /** Staff login limits in effect now (configuration `identity.staff_login`). */
  private async policy() {
    return (await this.config.resolve('identity.staff_login')).value;
  }

  async createAccount(input: {
    kind: 'staff' | 'center';
    username: string;
    password: string;
    displayName?: string;
  }): Promise<string> {
    if (input.password.length < (await this.policy()).minPasswordLength) {
      throw new BadRequestException({ error: 'password_too_short' });
    }
    const weak = weakPasswordReason(input.password, input.username.trim());
    if (weak) throw new BadRequestException({ error: weak });
    const [row] = await this.db
      .insert(userAccounts)
      .values({
        kind: input.kind,
        username: input.username.trim().toLowerCase(),
        displayName: input.displayName ?? null,
        passwordHash: await hashPassword(input.password),
      })
      .returning({ id: userAccounts.id });
    if (!row) throw new Error('account insert returned nothing');
    return row.id;
  }

  private async assertNotLocked(username: string, meta: RequestMeta) {
    for (const factor of ['password', 'totp'] as const) {
      const locked = await this.limiter.lockedFor(failureKey(factor, username));
      if (locked > 0) throw tooManyRequests('locked', locked);
    }
    if (meta.ip) {
      const ipLocked = await this.limiter.lockedFor(`staff-ip:${meta.ip}`);
      if (ipLocked > 0) throw tooManyRequests('rate_limited', ipLocked);
    }
  }

  /** Counts a wrong password or TOTP code; throws 429 if it triggered a lock, else 401. */
  private async fail(
    factor: Factor,
    username: string,
    meta: RequestMeta,
    error: string,
  ): Promise<never> {
    const [policy, { value: lockout }] = await Promise.all([
      this.policy(),
      this.config.resolve('identity.lockout'),
    ]);
    const lockedFor = await this.limiter.recordFailure(
      failureKey(factor, username),
      policy.failuresBeforeLock,
      lockout.failureWindowSeconds,
      lockout.lockSeconds,
    );
    if (meta.ip) {
      await this.limiter.recordFailure(
        `staff-ip:${meta.ip}`,
        policy.failuresPerIpPerHour,
        60 * 60,
        lockout.lockSeconds,
      );
    }
    if (lockedFor > 0) throw tooManyRequests('locked', lockedFor);
    throw new UnauthorizedException({ error });
  }

  /** Step 1: password. Always the same error for a wrong username or a wrong password. */
  async login(
    username: string,
    password: string,
    client: AuthClient,
    meta: RequestMeta,
  ): Promise<{ session: IssuedSession; next: 'totp' | 'totp_enroll' }> {
    await this.assertNotLocked(username, meta);
    const [account] = await this.db
      .select()
      .from(userAccounts)
      .where(and(eq(userAccounts.username, username), isNull(userAccounts.deletedAt)))
      .limit(1);

    const valid =
      account?.passwordHash != null && account.kind !== 'patient'
        ? await verifyPassword(account.passwordHash, password)
        : await verifyPassword(await dummyPasswordHash(), password).then(() => false);
    if (!account || !valid) return this.fail('password', username, meta, 'invalid_credentials');
    if (account.status !== 'active') throw new ForbiddenException({ error: 'account_disabled' });
    await this.limiter.clearFailures(failureKey('password', username));

    const session = await this.sessions.create(account.id, client, 'mfa_pending', meta);
    return { session, next: account.totpConfirmedAt ? 'totp' : 'totp_enroll' };
  }

  /** Step 2a, first login only: a new TOTP secret to scan. Not yet active until confirmed. */
  /**
   * Task 9-3 (R2; ASVS 2.1.5, 2.1.6, 3.3.3): a staff member's own new password, given the
   * current one. A wrong current password counts as a failed login (the same lock); the
   * account's other sessions end, this one stays; recorded, the password never.
   */
  async changePassword(
    actor: Actor,
    auth: AuthContext,
    input: { currentPassword: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<{ otherSessionsEnded: number }> {
    const account = await this.getStaffAccount(auth.accountId);
    const username = account.username ?? '';
    await this.assertNotLocked(username, meta);
    if (
      !account.passwordHash ||
      !(await verifyPassword(account.passwordHash, input.currentPassword))
    ) {
      return this.fail('password', username, meta, 'invalid_credentials');
    }
    if (input.newPassword.length < (await this.policy()).minPasswordLength) {
      throw new BadRequestException({ error: 'password_too_short' });
    }
    if (input.newPassword === input.currentPassword) {
      throw new BadRequestException({ error: 'password_unchanged' });
    }
    const weak = weakPasswordReason(input.newPassword, username);
    if (weak) throw new BadRequestException({ error: weak });
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.transaction(async (tx) => {
      await tx
        .update(userAccounts)
        .set({ passwordHash })
        .where(eq(userAccounts.id, auth.accountId));
      // Task 9-3 (R1): a re-authentication given before the change no longer counts.
      await tx
        .update(sessionRows)
        .set({ reauthenticatedAt: null })
        .where(eq(sessionRows.id, auth.sessionId));
      // Task 9-3 (R2): the account is told by SMS, after the commit.
      await this.notices.record(
        actor,
        { accountId: auth.accountId, event: 'password_changed', mobile: provedMobile(account) },
        tx,
      );
    });
    const otherSessionsEnded = await this.sessions.revokeOthers(
      auth.accountId,
      auth.sessionId,
      'password_changed',
    );
    await this.audit.record({
      actor,
      action: 'identity.password_changed',
      entityType: 'user_account',
      entityId: auth.accountId,
      after: { otherSessionsEnded },
    });
    return { otherSessionsEnded };
  }

  async enrollTotp(auth: AuthContext): Promise<{ secret: string; otpauthUri: string }> {
    const account = await this.getStaffAccount(auth.accountId);
    if (account.totpConfirmedAt) throw new ConflictException({ error: 'totp_already_enrolled' });
    const secret = newTotpSecret();
    await this.db
      .update(userAccounts)
      .set({
        totpSecretEncrypted: this.secrets.fieldCrypto.encrypt(secret, totpContext(account.id)),
        totpLastStep: null,
      })
      .where(eq(userAccounts.id, account.id));
    return { secret, otpauthUri: totpUri(secret, account.username ?? account.id, TOTP_ISSUER) };
  }

  /**
   * Step 2b: a TOTP code. Confirms enrollment on first use. A code is accepted once only:
   * its time step must be later than the last accepted one. On success the pending
   * session is revoked and a new, active one issued (no session fixation). A new device
   * confirmed after a TOTP reset is told to the account by SMS (task 9-3, R2).
   */
  async verifyTotp(auth: AuthContext, code: string, meta: RequestMeta, now = new Date()) {
    const account = await this.getStaffAccount(auth.accountId);
    const username = account.username ?? account.id;
    await this.assertNotLocked(username, meta);
    const step = this.stepOf(account, code, now);
    if (step === null) return this.fail('totp', username, meta, 'invalid_code');

    const afterReset = account.totpConfirmedAt === null && (await this.wasReset(account.id));
    const accepted = await this.db.transaction(async (tx) => {
      if (!(await this.acceptStep(tx, account, step, now))) return false;
      if (afterReset) {
        await this.notices.record(
          { accountId: account.id, sessionId: auth.sessionId, ip: meta.ip, roles: [] },
          { accountId: account.id, event: 'totp_enrolled', mobile: provedMobile(account) },
          tx,
        );
      }
      return true;
    });
    if (!accepted) return this.fail('totp', username, meta, 'invalid_code');

    await this.limiter.clearFailures(failureKey('password', username));
    await this.limiter.clearFailures(failureKey('totp', username));
    await this.sessions.revoke(account.id, auth.sessionId, 'mfa_completed', now);
    return this.sessions.create(account.id, auth.client, 'active', meta, now);
  }

  /**
   * Task 9-3 (R1; ASVS 3.7.1): a TOTP code given again in an active session, so that the
   * sensitive actions open in this session (and no other) for the window of
   * `identity.reauth`. The same rules as at sign-in: each code once (no replay, even of the
   * sign-in code), the same failure count and temporary lock, and every failure audited.
   * The session itself stays: nothing to fix.
   */
  async reauthenticate(
    actor: Actor,
    auth: AuthContext,
    code: string,
    meta: RequestMeta,
    now = new Date(),
  ): Promise<{ reauthenticatedUntil: string }> {
    const account = await this.getStaffAccount(auth.accountId);
    const username = account.username ?? account.id;
    const failed = (reason: string) =>
      this.audit.record({
        actor,
        action: 'identity.reauth_failed',
        entityType: 'user_account',
        entityId: account.id,
        after: { reason },
      });
    try {
      await this.assertNotLocked(username, meta);
    } catch (error) {
      await failed('locked');
      throw error;
    }
    if (!account.totpConfirmedAt) throw new ConflictException({ error: 'totp_not_enrolled' });
    const step = this.stepOf(account, code, now);
    const accepted =
      step !== null && (await this.db.transaction((tx) => this.acceptStep(tx, account, step, now)));
    if (!accepted) {
      await failed('invalid_code');
      return this.fail('totp', username, meta, 'invalid_code');
    }
    await this.limiter.clearFailures(failureKey('totp', username));
    await this.sessions.markReauthenticated(account.id, auth.sessionId, now);
    await this.audit.record({
      actor,
      action: 'identity.reauthenticated',
      entityType: 'user_account',
      entityId: account.id,
    });
    const { value } = await this.config.resolve('identity.reauth', {}, now);
    return {
      reauthenticatedUntil: new Date(now.getTime() + value.windowSeconds * 1000).toISOString(),
    };
  }

  /** The time step of a right code later than the last one accepted; null otherwise. */
  private stepOf(account: StaffAccount, code: string, now: Date): number | null {
    if (!account.totpSecretEncrypted) throw new ConflictException({ error: 'totp_not_enrolled' });
    const secret = this.secrets.fieldCrypto.decrypt(
      account.totpSecretEncrypted,
      totpContext(account.id),
    );
    const step = verifyTotp(secret, code, now.getTime());
    if (step === null || (account.totpLastStep !== null && step <= account.totpLastStep)) {
      return null;
    }
    return step;
  }

  /** Conditional update: two requests with the same code cannot both win. */
  private async acceptStep(tx: Tx, account: StaffAccount, step: number, now: Date) {
    const accepted = await tx
      .update(userAccounts)
      .set({ totpLastStep: step, totpConfirmedAt: account.totpConfirmedAt ?? now })
      .where(
        and(
          eq(userAccounts.id, account.id),
          account.totpLastStep === null
            ? isNull(userAccounts.totpLastStep)
            : eq(userAccounts.totpLastStep, account.totpLastStep),
        ),
      )
      .returning({ id: userAccounts.id });
    return accepted.length > 0;
  }

  /** Whether the account's TOTP was ever reset (its first enrollment is no change). */
  private async wasReset(accountId: string) {
    const [reset] = await this.db
      .select({ id: totpResetRequests.id })
      .from(totpResetRequests)
      .where(
        and(
          eq(totpResetRequests.targetAccountId, accountId),
          eq(totpResetRequests.status, 'approved'),
        ),
      )
      .limit(1);
    return reset !== undefined;
  }

  private async getStaffAccount(accountId: string) {
    const [account] = await this.db
      .select()
      .from(userAccounts)
      .where(and(eq(userAccounts.id, accountId), isNull(userAccounts.deletedAt)))
      .limit(1);
    if (!account || account.kind === 'patient') throw new ForbiddenException();
    return account;
  }
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type StaffAccount = typeof userAccounts.$inferSelect;

/** The mobile the account proved, if any: only that one is told of a change. */
const provedMobile = (account: { mobile: string | null; mobileVerifiedAt: Date | null }) =>
  account.mobileVerifiedAt !== null ? account.mobile : null;
