import { randomInt, randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  STEP_UP_OPERATIONS,
  type StepUpChallengeView,
  type StepUpOperation,
} from '@sepehr/contracts';
import type { Redis } from 'ioredis';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import type { FinancialStepUp, StepUpTarget } from '../../common/auth/step-up.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { REDIS } from '../../infra/redis.module';
import { STEP_UP_SENDER, type StepUpSender } from '../../infra/sms-queue';
import { IDENTITY_SECRETS, type IdentitySecrets } from './identity.tokens';
import { tooManyRequests } from './otp-login.service';
import { RateLimiter } from './rate-limiter';
import { StaffMobileChanges } from './staff-mobile-changes';
import { keyedHash, safeEqual } from './tokens';

interface StoredChallenge {
  readonly accountId: string;
  readonly operation: string;
  readonly codeHash: string;
  readonly expiresAt: string;
}

const HOUR = 60 * 60;

/** The operation as one string: type, record, amount (rials) and step; a code is for it alone. */
export function operationKey(t: StepUpTarget): string {
  return `${t.type}:${t.id}:${t.amountRial === null ? '-' : t.amountRial.toString()}:${t.step}`;
}

const masked = (mobile: string) => `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;

/**
 * ADR-052 (owner 1405/08/02): the SMS one-time code for a financial signature. Six digits,
 * random; kept only as an HMAC in Redis over the account, the operation (type, record, amount,
 * step) and the challenge, so a code works for nothing else; one use. The owner's numbers live
 * in `identity.financial_step_up` (two minutes, five tries then fifteen minutes' lock, a new
 * code after sixty seconds and three an hour). The code never reaches a log, the audit trail or
 * a response. Without SMS the action waits: there is no other way through. The whole check is
 * off (`enabled: false`) until the owner's conditions are met and two people turn it on
 * (owner 1405/08/03); while off, financial approvals need no code.
 */
@Injectable()
export class SmsOtpStepUp implements FinancialStepUp {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    @Inject(STEP_UP_SENDER) private readonly sender: StepUpSender,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly mobileChanges: StaffMobileChanges,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  private challengeKey(id: string) {
    return `identity:step-up:${id}`;
  }

  private currentKey(accountId: string, operation: string) {
    return `identity:step-up-current:${accountId}:${operation}`;
  }

  private lockKey(accountId: string, operation: string) {
    return `step-up:${accountId}:${operation}`;
  }

  private hash(challengeId: string, accountId: string, operation: string, code: string) {
    return keyedHash(
      this.secrets.authSecret,
      'step-up',
      `${challengeId}:${accountId}:${operation}:${code}`,
    );
  }

  /** Sends a code for one operation to the caller's own verified mobile. */
  async challenge(
    actor: Actor,
    op: StepUpOperation,
    now = new Date(),
  ): Promise<StepUpChallengeView> {
    if (actor.accountId === null || actor.sessionId === null) throw new UnauthorizedException();
    const accountId = actor.accountId;
    // A mobile change whose 24 hours have passed takes effect before a code goes out.
    await this.mobileChanges.applyDue(accountId, now);
    const account = await this.accounts.find(accountId);
    if (!account || account.kind === 'patient') throw new ForbiddenException();
    if (!account.mobile || !account.mobileVerified) {
      throw new ForbiddenException({ error: 'step_up_mobile_missing' });
    }
    const target: StepUpTarget = {
      type: op.type,
      id: op.id,
      amountRial: op.amountRial === null ? null : BigInt(op.amountRial),
      step: op.step,
    };
    const operation = operationKey(target);
    const { value: policy } = await this.config.resolve('identity.financial_step_up', {}, now);
    const locked = await this.limiter.lockedFor(this.lockKey(accountId, operation));
    if (locked > 0) throw tooManyRequests('locked', locked);
    // The sixty seconds and the hour's three count the codes of one operation (ADR-052 §6, a
    // resend): a signer approving many slips gets one code for each without waiting.
    // The sixty seconds first: a refused resend is not one of the hour's sends.
    const cooldownKey = `identity:step-up-cooldown:${accountId}:${operation}`;
    const claimed = await this.redis.set(cooldownKey, '1', 'EX', policy.resendAfterSeconds, 'NX');
    if (claimed === null) {
      throw tooManyRequests('resend_too_soon', Math.max(await this.redis.ttl(cooldownKey), 1));
    }
    const hourly = await this.limiter.hit(
      `step-up-send:${accountId}:${operation}`,
      policy.maxSendsPerHour,
      HOUR,
    );
    if (!hourly.allowed) {
      await this.redis.del(cooldownKey);
      throw tooManyRequests('rate_limited', hourly.retryAfterSeconds);
    }

    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + policy.codeTtlSeconds * 1000);
    try {
      await this.sender.sendStepUp({
        mobile: account.mobile,
        code,
        amountToman: target.amountRial === null ? null : (target.amountRial / 10n).toString(),
        operation: STEP_UP_OPERATIONS[op.type],
        expiresAt: expiresAt.toISOString(),
      });
    } catch {
      await this.redis.del(cooldownKey);
      throw new ServiceUnavailableException({ error: 'step_up_unavailable' });
    }
    // A new code ends the one before it, for the same operation.
    const previous = await this.redis.get(this.currentKey(accountId, operation));
    if (previous) await this.redis.del(this.challengeKey(previous));
    const stored: StoredChallenge = {
      accountId,
      operation,
      codeHash: this.hash(challengeId, accountId, operation, code),
      expiresAt: expiresAt.toISOString(),
    };
    await this.redis.set(
      this.challengeKey(challengeId),
      JSON.stringify(stored),
      'EX',
      policy.codeTtlSeconds,
    );
    await this.redis.set(
      this.currentKey(accountId, operation),
      challengeId,
      'EX',
      policy.codeTtlSeconds,
    );
    await this.audit.record({
      actor,
      action: 'identity.step_up_sent',
      entityType: op.type,
      entityId: op.id,
      after: { step: op.step, amountRial: op.amountRial, challengeId },
    });
    return {
      challengeId,
      maskedMobile: masked(account.mobile),
      expiresInSeconds: policy.codeTtlSeconds,
      resendAfterSeconds: policy.resendAfterSeconds,
    };
  }

  async assert(actor: Actor, target: StepUpTarget, now = new Date()): Promise<void> {
    if (actor.sessionId === null) return;
    if (actor.accountId === null) throw new UnauthorizedException();
    const { value: policy } = await this.config.resolve('identity.financial_step_up', {}, now);
    // Owner 1405/08/03: off until two people turn it on; until then no code is asked.
    if (!policy.enabled) return;
    const accountId = actor.accountId;
    const operation = operationKey(target);
    const required = () =>
      new ForbiddenException({
        error: 'step_up_required',
        operation: {
          type: target.type,
          id: target.id,
          amountRial: target.amountRial === null ? null : target.amountRial.toString(),
          step: target.step,
        },
      });
    const proof = actor.stepUp ?? null;
    if (!proof) throw required();
    const lockKey = this.lockKey(accountId, operation);
    const locked = await this.limiter.lockedFor(lockKey);
    if (locked > 0) throw tooManyRequests('locked', locked);

    const key = this.challengeKey(proof.challengeId);
    const raw = await this.redis.get(key);
    const stored = raw ? (JSON.parse(raw) as StoredChallenge) : null;
    const matches =
      stored !== null &&
      stored.accountId === accountId &&
      stored.operation === operation &&
      new Date(stored.expiresAt) > now &&
      safeEqual(stored.codeHash, this.hash(proof.challengeId, accountId, operation, proof.code));
    // One use: of two requests with the same code, only the one that deletes it goes on.
    if (matches && (await this.redis.del(key)) === 1) {
      await this.redis.del(this.currentKey(accountId, operation));
      await this.limiter.clearFailures(lockKey);
      await this.audit.record({
        actor,
        action: 'identity.step_up_verified',
        entityType: target.type,
        entityId: target.id,
        after: { step: target.step, challengeId: proof.challengeId },
      });
      return;
    }
    const lockedFor = await this.limiter.recordFailure(
      lockKey,
      policy.maxAttempts,
      policy.lockoutSeconds,
      policy.lockoutSeconds,
    );
    await this.audit.record({
      actor,
      action: 'identity.step_up_refused',
      entityType: target.type,
      entityId: target.id,
      after: { step: target.step, challengeId: proof.challengeId, locked: lockedFor > 0 },
    });
    if (lockedFor > 0) throw tooManyRequests('locked', lockedFor);
    throw new ForbiddenException({ error: 'step_up_invalid' });
  }
}
