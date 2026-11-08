import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { webhookIntakeSchema } from '@sepehr/contracts';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  NOTIFICATIONS,
  type NotificationsPort,
} from '../../common/notification/notifications.port';
import { DATABASE, type Database } from '../../db/database.module';
import { REDIS } from '../../infra/redis.module';
import { LeadIntakeService } from './intake.service';
import { webhookDeliveries } from './lead.schema';
import { lockKey } from './lead.shared';

/** The sources that may call the webhook, each with its secrets in the environment. */
const SOURCES = { wordpress: 'LEAD_WEBHOOK_SECRETS_WORDPRESS' } as const;
type Source = keyof typeof SOURCES;

export interface WebhookHeaders {
  readonly source: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly idempotencyKey: string | undefined;
}

/** The signature a sender computes: HMAC-SHA256 of `<timestamp>.<raw body>`, hex. */
export function webhookSignature(
  secret: string,
  timestamp: string,
  rawBody: Buffer | string,
): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

const tooMany = () => new HttpException({ error: 'rate_limited' }, HttpStatus.TOO_MANY_REQUESTS);

/**
 * The WordPress form's webhook (doc 05 §7; task 2-5b decision 5). Server to server only:
 * the WordPress plugin holds the secret and signs `<timestamp>.<body>` with HMAC-SHA256;
 * the secret never reaches a browser. A request is refused unless:
 *
 * - its source is known and its signature matches one of that source's secrets (two may
 *   be valid at once, for rotation: `LEAD_WEBHOOK_SECRETS_WORDPRESS=new,old`);
 * - its timestamp is within `lead.webhook_policy.maxAgeSeconds` of now (against replay);
 * - the source and the mobile are within their rate limits.
 *
 * An `Idempotency-Key` makes a retry of the same delivery return the first answer and
 * record nothing new. The form's hidden honeypot field, when filled, marks a bot: the
 * delivery is recorded as dropped and answered like any other, so the bot learns nothing.
 * No external captcha (national internet); an in-house one is TODO(decision).
 */
@Injectable()
export class LeadWebhookService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly intake: LeadIntakeService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The notification module's port, at first use (task 8-2: the form's consent). */
  private get notifications(): NotificationsPort {
    return this.moduleRef.get<NotificationsPort>(NOTIFICATIONS, { strict: false });
  }

  async receive(
    headers: WebhookHeaders,
    rawBody: Buffer | undefined,
    ip: string | null,
    now = new Date(),
  ): Promise<{ received: true; replayed: boolean }> {
    const policy = (await this.config.resolve('lead.webhook_policy')).value;
    const source = headers.source;
    if (!source || !Object.hasOwn(SOURCES, source)) {
      throw new UnauthorizedException({ error: 'unknown_source' });
    }
    const secrets = (process.env[SOURCES[source as Source]] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 32)
      .slice(0, 2);
    if (secrets.length === 0)
      throw new ServiceUnavailableException({ error: 'webhook_not_configured' });

    const timestamp = headers.timestamp ?? '';
    if (!/^\d{9,11}$/.test(timestamp)) throw new UnauthorizedException({ error: 'bad_timestamp' });
    if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > policy.maxAgeSeconds) {
      throw new UnauthorizedException({ error: 'stale_request' });
    }
    if (!rawBody) throw new BadRequestException({ error: 'body_required' });
    const given = /^v1=([0-9a-f]{64})$/.exec(headers.signature ?? '')?.[1];
    const valid =
      given !== undefined &&
      secrets.some((secret) =>
        timingSafeEqual(
          Buffer.from(webhookSignature(secret, timestamp, rawBody), 'hex'),
          Buffer.from(given, 'hex'),
        ),
      );
    if (!valid) throw new UnauthorizedException({ error: 'bad_signature' });

    const key = headers.idempotencyKey ?? '';
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
      throw new BadRequestException({ error: 'idempotency_key_required' });
    }
    if (!(await this.hit(`source:${source}`, policy.perSourcePerMinute, 60))) throw tooMany();

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException({ error: 'invalid_json' });
    }
    const parsed = webhookIntakeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_body',
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    const input = parsed.data;

    const settings = await this.intake.settings();
    return this.db.transaction(async (tx) => {
      await lockKey(tx, `lead.webhook:${source}:${key}`);
      const [earlier] = await tx
        .select()
        .from(webhookDeliveries)
        .where(
          and(eq(webhookDeliveries.source, source), eq(webhookDeliveries.idempotencyKey, key)),
        );
      if (earlier) return { received: true as const, replayed: true };

      const bot = input.website !== undefined && input.website.trim() !== '';
      if (bot) {
        await tx
          .insert(webhookDeliveries)
          .values({ source, idempotencyKey: key, status: 'dropped' });
        return { received: true as const, replayed: false };
      }
      if (!(await this.hit(`mobile:${input.mobile}`, policy.perMobilePerHour, 3600)))
        throw tooMany();
      const actor = { accountId: null, sessionId: null, ip, roles: [`webhook:${source}`] };
      const result = await this.intake.intakeIn(
        tx,
        actor,
        {
          mobile: input.mobile,
          name: input.name ?? null,
          treatmentFieldCode: input.treatmentFieldCode,
          cityCode: input.cityCode ?? null,
          channel: 'wordpress',
          smsConsent: input.smsConsent,
          utm: input.utm ?? null,
          pageUrl: input.pageUrl ?? null,
          referrer: input.referrer ?? null,
        },
        settings,
      );
      // Task 8-2 (the owner's ruling): the form's consent also in 6-4's consent ledger, which
      // promotional SMS read; no row without it, so an earlier withdrawal stands.
      if (input.smsConsent) {
        await this.notifications.recordConsent(
          actor,
          { mobile: input.mobile, source: 'wordpress' },
          tx,
        );
      }
      await tx.insert(webhookDeliveries).values({
        source,
        idempotencyKey: key,
        status: 'accepted',
        intakeId: result.intakeId,
      });
      return { received: true as const, replayed: false };
    });
  }

  /** Counts one request in a fixed window; false once over the limit. */
  private async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const redisKey = `lead:webhook:${key}`;
    const results = await this.redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds, 'NX')
      .exec();
    const count = (results?.[0]?.[1] as number | undefined) ?? Number.POSITIVE_INFINITY;
    return count <= limit;
  }
}
