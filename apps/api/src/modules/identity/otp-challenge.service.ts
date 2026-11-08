import { randomInt } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { OtpChallenge, OtpChallengeMeta } from '../../common/auth/otp-challenge.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { REDIS } from '../../infra/redis.module';
import type { OtpSender } from '../../infra/sms-queue';
import { IDENTITY_CONSTANTS } from './identity.policy';
import { IDENTITY_SECRETS, type IdentitySecrets } from './identity.tokens';
import { OTP_SENDER, tooManyRequests } from './otp-login.service';
import { RateLimiter } from './rate-limiter';
import { keyedHash, safeEqual } from './tokens';

const PURPOSE = /^[a-z][a-z0-9_]{1,40}$/;

interface StoredChallenge {
  readonly codeHash: string;
  readonly expiresAt: string;
}

/**
 * One-time codes for a confirmation other than login (task 3-5): the same policy as the
 * login code (`identity.otp`, `identity.lockout`), its own keys per purpose. The code is
 * kept only as an HMAC in Redis and expires on its own. The SMS is the login code's
 * template; TODO(decision): a wording of its own per purpose (Kavenegar template).
 */
@Injectable()
export class OtpChallengeService implements OtpChallenge {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  private key(purpose: string, mobile: string) {
    if (!PURPOSE.test(purpose)) throw new Error(`bad challenge purpose ${purpose}`);
    return `identity:challenge:${purpose}:${mobile}`;
  }

  private hash(purpose: string, mobile: string, code: string) {
    return keyedHash(this.secrets.authSecret, 'challenge', `${purpose}:${mobile}:${code}`);
  }

  async send(mobile: string, purpose: string, meta: OtpChallengeMeta, now = new Date()) {
    const { value: policy } = await this.config.resolve('identity.otp', {}, now);
    const lockKey = `challenge:${purpose}:${mobile}`;
    const locked = await this.limiter.lockedFor(lockKey);
    if (locked > 0) throw tooManyRequests('locked', locked);
    const hour = 60 * 60;
    const checks = [
      this.limiter.hit(`challenge-send:${purpose}:${mobile}`, policy.sendsPerMobilePerHour, hour),
      ...(meta.ip
        ? [this.limiter.hit(`otp-send:ip:${meta.ip}`, policy.sendsPerIpPerHour, hour)]
        : []),
    ];
    const denied = (await Promise.all(checks)).find((r) => !r.allowed);
    if (denied) throw tooManyRequests('rate_limited', denied.retryAfterSeconds);
    const cooldownKey = `identity:challenge-cooldown:${purpose}:${mobile}`;
    const claimed = await this.redis.set(
      cooldownKey,
      '1',
      'EX',
      policy.resendCooldownSeconds,
      'NX',
    );
    if (claimed === null) {
      throw tooManyRequests('resend_too_soon', Math.max(await this.redis.ttl(cooldownKey), 1));
    }
    const code = String(randomInt(0, 10 ** IDENTITY_CONSTANTS.otpLength)).padStart(
      IDENTITY_CONSTANTS.otpLength,
      '0',
    );
    const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
    try {
      await this.sender.sendOtp({ mobile, code, expiresAt: expiresAt.toISOString() });
    } catch (error) {
      await this.redis.del(cooldownKey);
      throw error;
    }
    const challenge: StoredChallenge = {
      codeHash: this.hash(purpose, mobile, code),
      expiresAt: expiresAt.toISOString(),
    };
    await this.redis.set(
      this.key(purpose, mobile),
      JSON.stringify(challenge),
      'EX',
      policy.ttlSeconds,
    );
    return {
      expiresInSeconds: policy.ttlSeconds,
      resendAfterSeconds: policy.resendCooldownSeconds,
    };
  }

  async verify(
    mobile: string,
    purpose: string,
    code: string,
    meta: OtpChallengeMeta,
    now = new Date(),
  ) {
    const lockKey = `challenge:${purpose}:${mobile}`;
    const locked = await this.limiter.lockedFor(lockKey);
    if (locked > 0) throw tooManyRequests('locked', locked);
    const raw = await this.redis.get(this.key(purpose, mobile));
    const challenge = raw ? (JSON.parse(raw) as StoredChallenge) : null;
    const matches =
      challenge !== null &&
      new Date(challenge.expiresAt) > now &&
      safeEqual(challenge.codeHash, this.hash(purpose, mobile, code));
    // Only one concurrent request may consume a correct code.
    if (!matches || (await this.redis.del(this.key(purpose, mobile))) === 0) {
      const [{ value: otp }, { value: lockout }] = await Promise.all([
        this.config.resolve('identity.otp', {}, now),
        this.config.resolve('identity.lockout', {}, now),
      ]);
      const lockedFor = await this.limiter.recordFailure(
        lockKey,
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
        await this.redis.del(this.key(purpose, mobile));
        throw tooManyRequests('locked', lockedFor);
      }
      throw new UnauthorizedException({ error: 'invalid_code' });
    }
    await this.limiter.clearFailures(lockKey);
  }
}
