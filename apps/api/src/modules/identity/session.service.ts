import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AuthClient, MobileTokens, SessionSummary } from '@sepehr/contracts';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { AuthContext } from '../../common/auth/auth.decorators';
import { DATABASE, type Database } from '../../db/database.module';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { IDENTITY_CONSTANTS } from './identity.policy';
import { refreshTokens, sessions, userAccounts } from './identity.schema';
import { IDENTITY_SECRETS, type IdentitySecrets, type RequestMeta } from './identity.tokens';
import { hashToken, keyedHash, newToken } from './tokens';

export type SessionStage = 'mfa_pending' | 'active';

/** What a new session hands back to the client. */
export interface IssuedSession {
  readonly sessionId: string;
  readonly client: AuthClient;
  readonly stage: SessionStage;
  /** Web: the `__Host-sid` cookie value. Mobile: the access token. */
  readonly token: string;
  readonly tokenExpiresAt: Date;
  /** Mobile, active sessions only. */
  readonly refreshToken: string | null;
  /** Web only: to be sent back in `X-CSRF-Token`. */
  readonly csrfToken: string | null;
}

const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

/** The earlier of two moments. */
const earlier = (a: Date, b: Date): Date => (a <= b ? a : b);

@Injectable()
export class SessionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  /** Session lifetimes in effect at `now` (configuration `identity.session`). */
  private async policy(now: Date) {
    return (await this.config.resolve('identity.session', {}, now)).value;
  }

  csrfToken(sessionId: string): string {
    return keyedHash(this.secrets.authSecret, 'csrf', sessionId);
  }

  async create(
    accountId: string,
    client: AuthClient,
    stage: SessionStage,
    meta: RequestMeta,
    now = new Date(),
  ): Promise<IssuedSession> {
    const token = newToken();
    const policy = await this.policy(now);
    const lifetime =
      stage === 'mfa_pending'
        ? (await this.config.resolve('identity.staff_login', {}, now)).value.pendingMfaTtlSeconds
        : client === 'web'
          ? Math.min(policy.webIdleSeconds, policy.webAbsoluteSeconds)
          : Math.min(policy.accessTokenSeconds, policy.mobileAbsoluteSeconds);
    const tokenExpiresAt = addSeconds(now, lifetime);

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({
          accountId,
          client,
          stage,
          tokenHash: hashToken(token),
          tokenExpiresAt,
          deviceId: meta.deviceId,
          deviceLabel: meta.userAgent?.slice(0, 200) ?? null,
          ip: meta.ip,
          authenticatedAt: now,
          lastSeenAt: now,
        })
        .returning({ id: sessions.id });
      if (!session) throw new Error('session insert returned nothing');

      let refreshToken: string | null = null;
      if (client === 'mobile' && stage === 'active') {
        refreshToken = newToken();
        await tx.insert(refreshTokens).values({
          sessionId: session.id,
          tokenHash: hashToken(refreshToken),
          expiresAt: addSeconds(
            now,
            Math.min(policy.refreshTokenSeconds, policy.mobileAbsoluteSeconds),
          ),
        });
      }
      return {
        sessionId: session.id,
        client,
        stage,
        token,
        tokenExpiresAt,
        refreshToken,
        csrfToken: client === 'web' ? this.csrfToken(session.id) : null,
      };
    });
  }

  /**
   * The caller behind a cookie or access token, or null. Checked on every request, so
   * revoking a session or disabling an account takes effect immediately. Web sessions
   * slide: each use (at most once a minute) extends the idle deadline.
   */
  async authenticate(
    token: string,
    client: AuthClient,
    now = new Date(),
  ): Promise<AuthContext | null> {
    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        accountId: sessions.accountId,
        kind: userAccounts.kind,
        stage: sessions.stage,
        authenticatedAt: sessions.authenticatedAt,
        reauthenticatedAt: sessions.reauthenticatedAt,
        lastSeenAt: sessions.lastSeenAt,
        mobile: userAccounts.mobile,
        mobileVerifiedAt: userAccounts.mobileVerifiedAt,
      })
      .from(sessions)
      .innerJoin(userAccounts, eq(userAccounts.id, sessions.accountId))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          eq(sessions.client, client),
          isNull(sessions.revokedAt),
          gt(sessions.tokenExpiresAt, now),
          eq(userAccounts.status, 'active'),
          isNull(userAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    // Task 9-3 (R1): past its absolute lifetime a session is over, however active it was.
    const policy = await this.policy(now);
    const absolute = client === 'web' ? policy.webAbsoluteSeconds : policy.mobileAbsoluteSeconds;
    const endsAt = addSeconds(row.authenticatedAt, absolute);
    if (endsAt <= now) return null;

    const touchMs = IDENTITY_CONSTANTS.sessionTouchIntervalSeconds * 1000;
    if (now.getTime() - row.lastSeenAt.getTime() >= touchMs) {
      const slides = client === 'web' && row.stage === 'active';
      await this.db
        .update(sessions)
        .set(
          slides
            ? {
                lastSeenAt: now,
                tokenExpiresAt: earlier(addSeconds(now, policy.webIdleSeconds), endsAt),
              }
            : { lastSeenAt: now },
        )
        .where(eq(sessions.id, row.sessionId));
    }
    return {
      accountId: row.accountId,
      sessionId: row.sessionId,
      client,
      kind: row.kind,
      stage: row.stage,
      authenticatedAt: row.authenticatedAt,
      reauthenticatedAt: row.reauthenticatedAt,
      mobileVerified: row.mobile !== null && row.mobileVerifiedAt !== null,
    };
  }

  /**
   * Rotates a mobile refresh token. A token already used is a sign of theft: the whole
   * session is revoked and the call fails, so neither the thief nor the victim keeps it.
   */
  async refresh(refreshToken: string, now = new Date()): Promise<MobileTokens> {
    const policy = await this.policy(now);
    const outcome = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(refreshToken)))
        .for('update');
      if (!current) return { ok: false as const };

      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, current.sessionId))
        .for('update');
      if (!session || session.revokedAt !== null || session.stage !== 'active') {
        return { ok: false as const };
      }

      if (current.usedAt !== null) {
        await tx
          .update(sessions)
          .set({ revokedAt: now, revokeReason: 'refresh_token_reuse' })
          .where(eq(sessions.id, session.id));
        return { ok: false as const };
      }
      if (current.expiresAt <= now) return { ok: false as const };

      // Task 9-3 (R1): no refresh past the session's absolute lifetime.
      const endsAt = addSeconds(session.authenticatedAt, policy.mobileAbsoluteSeconds);
      if (endsAt <= now) return { ok: false as const };

      await tx.update(refreshTokens).set({ usedAt: now }).where(eq(refreshTokens.id, current.id));
      const accessToken = newToken();
      const accessTokenExpiresAt = earlier(addSeconds(now, policy.accessTokenSeconds), endsAt);
      await tx
        .update(sessions)
        .set({
          tokenHash: hashToken(accessToken),
          tokenExpiresAt: accessTokenExpiresAt,
          lastSeenAt: now,
        })
        .where(eq(sessions.id, session.id));
      const next = newToken();
      await tx.insert(refreshTokens).values({
        sessionId: session.id,
        tokenHash: hashToken(next),
        parentId: current.id,
        expiresAt: earlier(addSeconds(now, policy.refreshTokenSeconds), endsAt),
      });
      return {
        ok: true as const,
        tokens: {
          accessToken,
          accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
          refreshToken: next,
        },
      };
    });
    if (!outcome.ok) throw new UnauthorizedException({ error: 'invalid_refresh_token' });
    return outcome.tokens;
  }

  async list(
    accountId: string,
    currentSessionId: string,
    now = new Date(),
  ): Promise<SessionSummary[]> {
    const policy = await this.policy(now);
    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.accountId, accountId),
          eq(sessions.stage, 'active'),
          isNull(sessions.revokedAt),
          // A mobile session lives as long as its refresh token, which is renewed on use.
          sql`((${sessions.client} = 'web' AND ${sessions.tokenExpiresAt} > ${now})
            OR (${sessions.client} = 'mobile'
                AND ${sessions.lastSeenAt} > ${addSeconds(now, -policy.refreshTokenSeconds)}))`,
        ),
      )
      .orderBy(desc(sessions.lastSeenAt));
    return rows.map((s) => ({
      id: s.id,
      client: s.client,
      deviceLabel: s.deviceLabel,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      current: s.id === currentSessionId,
    }));
  }

  /** Revokes one of the caller's own sessions. Another account's session is "not found". */
  async revoke(accountId: string, sessionId: string, reason: string, now = new Date()) {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.accountId, accountId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    if (revoked.length === 0) throw new NotFoundException();
  }

  /**
   * Task 9-3 (R1): this live, active session gave a TOTP code again; sensitive actions are
   * open in it, and in no other, for the configured window.
   */
  async markReauthenticated(accountId: string, sessionId: string, now = new Date()) {
    const marked = await this.db
      .update(sessions)
      .set({ reauthenticatedAt: now })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.accountId, accountId),
          eq(sessions.stage, 'active'),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    if (marked.length === 0) throw new UnauthorizedException({ error: 'not_authenticated' });
  }

  /** Task 9-3 (R1): the session's re-authentication no longer counts (a password change). */
  async clearReauthentication(sessionId: string) {
    await this.db
      .update(sessions)
      .set({ reauthenticatedAt: null })
      .where(eq(sessions.id, sessionId));
  }

  /** Every session of the account but this one (task 9-3: after a password change). */
  async revokeOthers(
    accountId: string,
    keepSessionId: string,
    reason: string,
    now = new Date(),
  ): Promise<number> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(
        and(
          eq(sessions.accountId, accountId),
          isNull(sessions.revokedAt),
          ne(sessions.id, keepSessionId),
        ),
      )
      .returning({ id: sessions.id });
    return revoked.length;
  }

  /** Logs the account out everywhere; returns how many sessions ended. */
  async revokeAll(accountId: string, reason: string, now = new Date()): Promise<number> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return revoked.length;
  }
}
