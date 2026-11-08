import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SETUP_TOKEN_HOURS, type SetupTokenView } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import type { CenterAccounts } from '../../common/auth/center-accounts.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { REDIS } from '../../infra/redis.module';
import type { TextSmsSender } from '../../infra/sms-queue';
import { toPersianDigits } from '@sepehr/contracts';
import { userAccounts } from './identity.schema';
import { IDENTITY_SECRETS, type IdentitySecrets } from './identity.tokens';
import { tooManyRequests } from './otp-login.service';
import { hashPassword, weakPasswordReason } from './password';
import { RateLimiter } from './rate-limiter';
import { keyedHash } from './tokens';

/** The queue of the link's SMS: a text that no table records (its token is a secret). */
export const SETUP_LINK_SENDER = Symbol('SETUP_LINK_SENDER');

/** Wrong or spent tokens tried from one address before it waits (an hour). */
const TRIES_PER_IP_PER_HOUR = 20;
/** Passwords refused for one token before the token is spent. */
const MAX_ATTEMPTS = 5;

interface TokenRow {
  id: string;
  account_id: string;
  expires_at: Date;
  used_at: Date | null;
  attempts: number;
  username: string | null;
}

/**
 * A center user's one-time link (owner 1405/08/10; migration 0110): made with the account of
 * an approved partnership request, valid {@link SETUP_TOKEN_HOURS} hours, kept only as an HMAC,
 * used once. Its user sets their own password with it; the authenticator app follows at the
 * first sign-in, as for every staff and center user. Tries are limited per address, and a
 * token refusing too many passwords is spent.
 */
@Injectable()
export class AccountSetupService implements CenterAccounts {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(REDIS) redis: Redis,
    @Inject(SETUP_LINK_SENDER) private readonly sms: TextSmsSender,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  private hash(token: string) {
    return keyedHash(this.secrets.authSecret, 'account-setup', token);
  }

  async provision(
    actor: Actor,
    input: {
      username: string;
      displayName: string;
      mobile: string;
      linkOrigin: string;
      requestNumber: number;
    },
    now = new Date(),
  ): Promise<{ accountId: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SETUP_TOKEN_HOURS * 60 * 60 * 1000);
    // No usable password until the user sets one: a random one nobody ever sees.
    const unusable = await hashPassword(randomBytes(32).toString('base64url'));
    const username = input.username.trim().toLowerCase();
    const accountId = await this.db.transaction(async (tx) => {
      // A retry after a failed SMS: the account made then, its setup never finished, is the
      // same center user's (same username and mobile); its old links are spent, a new one made.
      const earlier = (
        await tx.execute(sql`
          SELECT a.id, a.mobile FROM user_accounts a
          WHERE a.username = ${username} AND a.kind = 'center' AND a.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM account_setup_tokens t WHERE t.account_id = a.id)
            AND NOT EXISTS (
              SELECT 1 FROM account_setup_tokens t WHERE t.account_id = a.id AND t.used_at IS NOT NULL
                AND t.attempts < ${MAX_ATTEMPTS} AND t.expires_at > t.used_at
            )
          FOR UPDATE
        `)
      ).rows[0];
      let id: string;
      if (earlier) {
        if (earlier['mobile'] !== input.mobile)
          throw new ConflictException({ error: 'username_taken' });
        id = earlier['id'] as string;
        await tx.execute(sql`
          UPDATE account_setup_tokens SET used_at = ${now.toISOString()}, attempts = ${MAX_ATTEMPTS}
          WHERE account_id = ${id} AND used_at IS NULL
        `);
      } else {
        const [row] = await tx
          .insert(userAccounts)
          .values({
            kind: 'center',
            username,
            displayName: input.displayName,
            passwordHash: unusable,
            // The applicant proved this mobile with a code before the request was accepted.
            mobile: input.mobile,
            mobileVerifiedAt: now,
          })
          .returning({ id: userAccounts.id })
          .catch((error: unknown) => {
            if (String((error as { code?: string }).code) === '23505') {
              throw new ConflictException({ error: 'username_taken' });
            }
            throw error;
          });
        if (!row) throw new Error('account insert returned nothing');
        id = row.id;
      }
      await tx.execute(sql`
        INSERT INTO account_setup_tokens (account_id, token_hash, expires_at, created_by)
        VALUES (${id}, ${this.hash(token)}, ${expiresAt.toISOString()}, ${actor.accountId})
      `);
      await this.audit.record(
        {
          actor,
          action: earlier
            ? 'identity.center_account_link_renewed'
            : 'identity.center_account_provisioned',
          entityType: 'user_account',
          entityId: id,
          after: { username, mobileVerified: true, setupExpiresAt: expiresAt },
        },
        tx,
      );
      return id;
    });
    // After the commit, once: the token goes only into this SMS.
    const link = `${input.linkOrigin.replace(/\/$/, '')}/setup#${token}`;
    await this.sms.sendText(
      {
        mobile: input.mobile,
        text: `درخواست همکاری ${toPersianDigits(String(input.requestNumber))} در سپهر سلامتی تأیید شد. نام کاربری: ${input.username} — ساخت رمز و ورود دومرحله‌ای تا ۲۴ ساعت: ${link}`,
        notAfter: expiresAt.toISOString(),
      },
      // BullMQ ids take no colon; a renewed link is a job of its own.
      `setup-link-${accountId}-${String(expiresAt.getTime())}`,
    );
    return { accountId, expiresAt };
  }

  private async row(token: string): Promise<TokenRow | null> {
    const rows = await this.db.execute(sql`
      SELECT t.id, t.account_id, t.expires_at, t.used_at, t.attempts, a.username
      FROM account_setup_tokens t JOIN user_accounts a ON a.id = t.account_id
      WHERE t.token_hash = ${this.hash(token)} AND a.deleted_at IS NULL AND a.status = 'active'
    `);
    const r = rows.rows[0];
    if (!r) return null;
    return {
      id: r['id'] as string,
      account_id: r['account_id'] as string,
      expires_at: new Date(r['expires_at'] as string),
      used_at: r['used_at'] ? new Date(r['used_at'] as string) : null,
      attempts: Number(r['attempts']),
      username: (r['username'] as string | null) ?? null,
    };
  }

  /** A live token, else 404 (unknown), 410 (spent or expired); tries limited per address. */
  private async live(token: string, ip: string | null, now: Date): Promise<TokenRow> {
    if (ip) {
      const locked = await this.limiter.lockedFor(`setup-ip:${ip}`);
      if (locked > 0) throw tooManyRequests('rate_limited', locked);
    }
    const row = await this.row(token);
    const fail = async () => {
      if (ip) await this.limiter.recordFailure(`setup-ip:${ip}`, TRIES_PER_IP_PER_HOUR, 3600, 3600);
    };
    if (!row) {
      await fail();
      throw new NotFoundException({ error: 'setup_link_not_found' });
    }
    if (row.used_at || row.expires_at <= now || row.attempts >= MAX_ATTEMPTS) {
      await fail();
      throw new GoneException({ error: 'setup_link_expired' });
    }
    return row;
  }

  async check(token: string, ip: string | null, now = new Date()): Promise<SetupTokenView> {
    const row = await this.live(token, ip, now);
    return { username: row.username ?? '', expiresAt: row.expires_at.toISOString() };
  }

  /** Sets the password and spends the token; a weak password counts toward its attempts. */
  async setPassword(
    input: { token: string; password: string },
    ip: string | null,
    now = new Date(),
  ): Promise<{ username: string }> {
    const row = await this.live(input.token, ip, now);
    const { value: policy } = await this.config.resolve('identity.staff_login', {}, now);
    const problem =
      input.password.length < policy.minPasswordLength
        ? 'password_too_short'
        : weakPasswordReason(input.password, row.username ?? '');
    if (problem) {
      await this.db.execute(sql`
        UPDATE account_setup_tokens SET attempts = attempts + 1 WHERE id = ${row.id}
      `);
      throw new BadRequestException({ error: problem });
    }
    const passwordHash = await hashPassword(input.password);
    await this.db.transaction(async (tx) => {
      // Only one request spends the token.
      const spent = await tx.execute(sql`
        UPDATE account_setup_tokens SET used_at = ${now.toISOString()}
        WHERE id = ${row.id} AND used_at IS NULL RETURNING id
      `);
      if (spent.rows.length === 0) throw new GoneException({ error: 'setup_link_expired' });
      await tx.execute(sql`
        UPDATE user_accounts SET password_hash = ${passwordHash}
        WHERE id = ${row.account_id} AND deleted_at IS NULL
      `);
      await this.audit.record(
        {
          actor: { accountId: row.account_id, ip, sessionId: null, roles: [] },
          action: 'identity.center_account_password_set',
          entityType: 'user_account',
          entityId: row.account_id,
          after: { via: 'setup_link' },
        },
        tx,
      );
    });
    return { username: row.username ?? '' };
  }
}
