import { randomInt } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { PERSON_DIRECTORY, type AuthClient, type PersonDirectory } from '@sepehr/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { DATABASE, type Database } from '../../db/database.module';
import { REDIS } from '../../infra/redis.module';
import type { OtpSender } from '../../infra/sms-queue';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { IDENTITY_CONSTANTS } from './identity.policy';
import { userAccounts } from './identity.schema';
import { IDENTITY_SECRETS, type IdentitySecrets, type RequestMeta } from './identity.tokens';
import { RateLimiter } from './rate-limiter';
import { SessionService, type IssuedSession } from './session.service';
import { stagingLoginCodeFromEnv } from './staging-code';
import { keyedHash, safeEqual } from './tokens';

export const OTP_SENDER = Symbol('OTP_SENDER');

const CODE_LENGTH = IDENTITY_CONSTANTS.otpLength;

/** 429 with the number of seconds to wait. */
export function tooManyRequests(error: string, retryAfterSeconds: number): HttpException {
  return new HttpException({ error, retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
}

interface StoredChallenge {
  readonly codeHash: string;
  readonly expiresAt: string;
}

/**
 * Patient login by one-time code (OtpChallenge). The challenge lives only in Redis, as an
 * HMAC of the code, and expires on its own. Responses never reveal whether a mobile
 * already has an account.
 */
@Injectable()
export class OtpLoginService {
  private readonly logger = new Logger(OtpLoginService.name);
  private readonly limiter: RateLimiter;
  /** The staging's fixed code (task 9-4), or null: random, as everywhere else. */
  private readonly stagingCode = stagingLoginCodeFromEnv(process.env);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Optional() @Inject(PERSON_DIRECTORY) private readonly persons: PersonDirectory | null,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  private challengeKey(mobile: string) {
    return `identity:otp:${mobile}`;
  }

  private codeHash(mobile: string, code: string) {
    return keyedHash(this.secrets.authSecret, 'otp', `${mobile}:${code}`);
  }

  /** Sends a code, within the per-mobile, per-IP and per-device limits. */
  async request(mobile: string, meta: RequestMeta, now = new Date()) {
    const { value: policy } = await this.config.resolve('identity.otp', {}, now);
    const locked = await this.limiter.lockedFor(`otp:${mobile}`);
    if (locked > 0) throw tooManyRequests('locked', locked);

    // Order matters: a request refused by a limit, or whose SMS cannot be queued, must
    // neither start the cooldown nor replace the code already on the patient's phone.
    const cooldownKey = `identity:otp-cooldown:${mobile}`;
    const cooldownLeft = await this.redis.ttl(cooldownKey);
    if (cooldownLeft > 0) throw tooManyRequests('resend_too_soon', cooldownLeft);

    const hour = 60 * 60;
    const checks = [
      this.limiter.hit(`otp-send:mobile:${mobile}`, policy.sendsPerMobilePerHour, hour),
      ...(meta.ip
        ? [this.limiter.hit(`otp-send:ip:${meta.ip}`, policy.sendsPerIpPerHour, hour)]
        : []),
      ...(meta.deviceId
        ? [this.limiter.hit(`otp-send:device:${meta.deviceId}`, policy.sendsPerDevicePerHour, hour)]
        : []),
    ];
    const denied = (await Promise.all(checks)).find((r) => !r.allowed);
    if (denied) throw tooManyRequests('rate_limited', denied.retryAfterSeconds);

    // Claimed atomically: of two concurrent requests only one sends a code.
    const claimed = await this.redis.set(
      cooldownKey,
      '1',
      'EX',
      policy.resendCooldownSeconds,
      'NX',
    );
    if (claimed === null) {
      const ttl = await this.redis.ttl(cooldownKey);
      throw tooManyRequests('resend_too_soon', Math.max(ttl, 1));
    }

    const code =
      this.stagingCode ?? String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
    try {
      await this.sender.sendOtp({ mobile, code, expiresAt: expiresAt.toISOString() });
    } catch (error) {
      await this.redis.del(cooldownKey);
      throw error;
    }
    const challenge: StoredChallenge = {
      codeHash: this.codeHash(mobile, code),
      expiresAt: expiresAt.toISOString(),
    };
    await this.redis.set(
      this.challengeKey(mobile),
      JSON.stringify(challenge),
      'EX',
      policy.ttlSeconds,
    );

    return {
      expiresInSeconds: policy.ttlSeconds,
      resendAfterSeconds: policy.resendCooldownSeconds,
    };
  }

  /**
   * Checks a code and logs the patient in. The 6th wrong code within the window locks the
   * mobile for a while; the pending code is discarded, so a new one is needed afterwards.
   */
  async verify(
    mobile: string,
    code: string,
    client: AuthClient,
    meta: RequestMeta,
    now = new Date(),
  ): Promise<IssuedSession> {
    const locked = await this.limiter.lockedFor(`otp:${mobile}`);
    if (locked > 0) throw tooManyRequests('locked', locked);
    if (meta.ip) {
      const ipLocked = await this.limiter.lockedFor(`otp-ip:${meta.ip}`);
      if (ipLocked > 0) throw tooManyRequests('rate_limited', ipLocked);
    }

    const raw = await this.redis.get(this.challengeKey(mobile));
    const challenge = raw ? (JSON.parse(raw) as StoredChallenge) : null;
    const matches =
      challenge !== null &&
      new Date(challenge.expiresAt) > now &&
      safeEqual(challenge.codeHash, this.codeHash(mobile, code));

    // Only one concurrent request may consume a correct code.
    if (!matches || (await this.redis.del(this.challengeKey(mobile))) === 0) {
      await this.recordFailure(mobile, meta, now);
      throw new UnauthorizedException({ error: 'invalid_code' });
    }
    await this.limiter.clearFailures(`otp:${mobile}`);

    const account = await this.findOrCreatePatient(mobile);
    if (account.status !== 'active') throw new ForbiddenException({ error: 'account_disabled' });
    await this.linkPerson(account.id, account.personId, mobile, now);
    return this.sessions.create(account.id, client, 'active', meta, now);
  }

  private async recordFailure(mobile: string, meta: RequestMeta, now: Date) {
    const [{ value: otp }, { value: lockout }] = await Promise.all([
      this.config.resolve('identity.otp', {}, now),
      this.config.resolve('identity.lockout', {}, now),
    ]);
    const lockedFor = await this.limiter.recordFailure(
      `otp:${mobile}`,
      otp.failuresBeforeLock,
      lockout.failureWindowSeconds,
      lockout.lockSeconds,
    );
    if (meta.ip) {
      await this.limiter.recordFailure(
        `otp-ip:${meta.ip}`,
        otp.failuresPerIpPerHour,
        60 * 60,
        lockout.lockSeconds,
      );
    }
    if (lockedFor > 0) {
      await this.redis.del(this.challengeKey(mobile));
      throw tooManyRequests('locked', lockedFor);
    }
  }

  private async findOrCreatePatient(mobile: string) {
    const existing = await this.findPatient(mobile);
    if (existing) return existing;
    // Two first logins at once: the unique index lets only one insert through.
    await this.db.insert(userAccounts).values({ kind: 'patient', mobile }).onConflictDoNothing();
    const created = await this.findPatient(mobile);
    if (!created) throw new Error('patient account could not be created');
    return created;
  }

  private async findPatient(mobile: string) {
    const [row] = await this.db
      .select({ id: userAccounts.id, status: userAccounts.status, personId: userAccounts.personId })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.kind, 'patient'),
          eq(userAccounts.mobile, mobile),
          isNull(userAccounts.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Links the account to the one Person of this mobile (doc 05), through the port of the
   * module that owns Person, and tells it the mobile is proved (task 9-3). Once linked it is
   * not asked again: the login that linked it proved the mobile (migration 0081 proved those
   * linked before). A pending mobile stands for nobody: the account stays unlinked, and sees
   * nothing, until the mobile is approved. A failure here does not block the login: the link
   * is retried on the next login, since person_id stays empty.
   *
   * The lead module provides PERSON_DIRECTORY (task 2-5b); the accounts made before it
   * are linked by `pnpm lead:backfill-persons` (PersonBackfill).
   */
  private async linkPerson(accountId: string, personId: string | null, mobile: string, now: Date) {
    if (personId !== null || !this.persons) return;
    try {
      const person = await this.persons.linkLogin(mobile, now);
      if (person.personId === null) return;
      await this.db
        .update(userAccounts)
        .set({ personId: person.personId })
        .where(and(eq(userAccounts.id, accountId), isNull(userAccounts.personId)));
    } catch (error) {
      this.logger.error(
        `linking account ${accountId} to a person failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
