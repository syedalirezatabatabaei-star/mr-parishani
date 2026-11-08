import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  forbiddenFields,
  nextAllowedAt,
  normalizeMobile,
  renderTemplate,
  smsSegments,
  templateFields,
  type PermissionCode,
  type SmsAudience,
  type SmsCategory,
  type SmsDispatchStatus,
  type SmsDispatchView,
  type SmsTemplateView,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  SMS_DELIVERY_STATUS,
  type NotificationsPort,
  type SendSms,
  type SmsDeliveryStatus,
} from '../../common/notification/notifications.port';
import { DATABASE, type Database } from '../../db/database.module';
import type { TextSmsSender } from '../../infra/sms-queue';

/** The notification module's queue producer (the same SMS queue as every other module). */
export const NOTIFICATION_SMS_SENDER = Symbol('NOTIFICATION_SMS_SENDER');

const TEMPLATES: PermissionCode = 'notification.manage_templates';
const DISPATCHES: PermissionCode = 'notification.read_dispatches';
const CONSENT: PermissionCode = 'notification.manage_consent';
const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE_BATCH = 200;
/** A queued SMS still unsent after this is queued again (the queue lost its job). */
const REQUEUE_AFTER_MS = 10 * 60 * 1000;

const iso = (c: string) =>
  sql.raw(`to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const mask = (mobile: string) => `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;

export interface TemplateRow {
  id: string;
  code: string;
  version: number;
  audience: SmsAudience;
  category: SmsCategory;
  body: string;
  reason: string;
  created_at: string;
}

/**
 * SMS of phase 6 on (task 6-4; doc 15 §7, tests 6, 9, 10):
 *
 * - templates: versioned (append-only), saved only with the fields their recipient may see;
 * - send: the newest version filled; a promotional one without consent, or after its
 *   withdrawal, is recorded `suppressed`; a non-urgent one outside the allowed hours waits
 *   (`scheduled`) for their next opening, Tehran; parts and an estimated price recorded;
 * - release (the worker, often): what is due is queued, once, by its own id;
 * - delivery (the worker): the provider's reports on what was sent.
 *
 * Mobiles are kept on the record (operational data) and never logged (rule 30).
 */
@Injectable()
export class NotificationService implements NotificationsPort {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(NOTIFICATION_SMS_SENDER) private readonly sender: TextSmsSender,
    @Inject(SMS_DELIVERY_STATUS) private readonly delivery: SmsDeliveryStatus,
  ) {}

  // --- sending --------------------------------------------------------------------------

  async send(
    input: SendSms,
    tx?: SqlExecutor,
    now = new Date(),
  ): Promise<{ dispatchId: string; status: SmsDispatchStatus }> {
    const ex = tx ?? this.db;
    const mobile = normalizeMobile(input.mobile);
    if (!mobile) throw new BadRequestException({ error: 'invalid_mobile' });
    const earlier = (
      await ex.execute(sql`
        SELECT id, status FROM sms_dispatches WHERE idempotency_key = ${input.idempotencyKey}
      `)
    ).rows[0];
    if (earlier) {
      return {
        dispatchId: earlier['id'] as string,
        status: earlier['status'] as SmsDispatchStatus,
      };
    }
    const template = input.templateId
      ? await this.version(ex, input.templateId, input.templateCode)
      : await this.current(ex, input.templateCode);
    if (!template) throw new NotFoundException({ error: 'template_not_found' });
    if (template.audience !== input.audience) {
      throw new ConflictException({ error: 'template_audience_differs' });
    }
    // Only the fields this recipient may see reach the text (doc 04 §4).
    const text = renderTemplate(template.body, input.values);
    const segments = smsSegments(text);
    const [hours, price] = await Promise.all([
      this.config.resolve('notification.allowed_hours', {}, now),
      this.config.resolve('notification.segment_cost_rial', {}, now),
    ]);
    const cost = BigInt(segments) * BigInt(price.value);

    let status: SmsDispatchStatus = 'scheduled';
    let reason: string | null = null;
    const from = input.sendAfter && input.sendAfter > now ? input.sendAfter : now;
    if (template.category === 'urgent' && from !== now) {
      throw new ConflictException({ error: 'urgent_not_schedulable' });
    }
    let sendAfter = from;
    if (template.category === 'promotional') {
      const consent = await this.consentOf(ex, mobile);
      if (consent !== 'consent') {
        status = 'suppressed';
        reason = consent === 'withdraw' ? 'unsubscribed' : 'no_consent';
      }
    }
    if (status !== 'suppressed') {
      if (template.category === 'urgent') status = 'pending';
      else sendAfter = nextAllowedAt(from, hours.value);
    }
    const notAfter = input.notAfter ?? new Date(sendAfter.getTime() + DAY_MS);
    const made = await ex.execute(sql`
      INSERT INTO sms_dispatches (
        template_id, category, audience, person_id, mobile, text, segments, cost_estimate_rial,
        status, suppressed_reason, send_after, not_after, idempotency_key
      ) VALUES (
        ${template.id}, ${template.category}, ${template.audience}, ${input.personId ?? null},
        ${mobile}, ${text}, ${segments}, ${cost}, ${status}, ${reason}, ${sendAfter},
        ${notAfter}, ${input.idempotencyKey}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `);
    const id = made.rows[0]?.['id'] as string | undefined;
    if (!id) {
      // Recorded at the same moment by another call with the same key.
      const again = (
        await ex.execute(sql`
          SELECT id, status FROM sms_dispatches WHERE idempotency_key = ${input.idempotencyKey}
        `)
      ).rows[0];
      return {
        dispatchId: again?.['id'] as string,
        status: again?.['status'] as SmsDispatchStatus,
      };
    }
    return { dispatchId: id, status };
  }

  /**
   * The worker, often: what is due (scheduled, its moment come) becomes pending; what is
   * pending and not yet queued is queued, under its own id, after the commit. One queued
   * long ago and still unsent (a job the queue lost) is queued again. One past its last
   * moment is cancelled.
   */
  async release(now = new Date()): Promise<{ queued: number; cancelled: number }> {
    const stale = new Date(now.getTime() - REQUEUE_AFTER_MS);
    const due = await this.db.transaction(async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT id, status, mobile, text, not_after FROM sms_dispatches
          WHERE (status = 'scheduled' AND send_after <= ${now})
             OR (status = 'pending' AND sent_at IS NULL
                 AND (queued_at IS NULL OR queued_at < ${stale}))
          ORDER BY send_after, id
          LIMIT ${RELEASE_BATCH}
          FOR UPDATE SKIP LOCKED
        `)
      ).rows;
      const late = rows.filter((r) => new Date(r['not_after'] as string) <= now);
      const ready = rows.filter((r) => new Date(r['not_after'] as string) > now);
      for (const r of late) {
        await tx.execute(
          sql`UPDATE sms_dispatches SET status = 'cancelled' WHERE id = ${r['id'] as string}`,
        );
      }
      if (ready.length > 0) {
        await tx.execute(sql`
          UPDATE sms_dispatches SET status = 'pending', queued_at = ${now}
          WHERE id IN (${sql.join(
            ready.map((r) => sql`${r['id'] as string}`),
            sql`, `,
          )})
        `);
      }
      return { ready, cancelled: late.length };
    });
    // After the commit: a rolled-back release queues nothing.
    for (const r of due.ready) {
      await this.sender.sendText(
        {
          mobile: r['mobile'] as string,
          text: r['text'] as string,
          notAfter: new Date(r['not_after'] as string).toISOString(),
          dispatchId: r['id'] as string,
        },
        `sms-dispatch-${r['id'] as string}`,
      );
    }
    return { queued: due.ready.length, cancelled: due.cancelled };
  }

  async preview(
    templateCode: string,
    audience: SmsAudience,
    values: Readonly<Record<string, string>>,
  ): Promise<string> {
    const template = await this.current(this.db, templateCode);
    if (!template) throw new NotFoundException({ error: 'template_not_found' });
    if (template.audience !== audience) {
      throw new ConflictException({ error: 'template_audience_differs' });
    }
    return renderTemplate(template.body, values);
  }

  async cancelScheduled(keyPrefix: string, tx?: SqlExecutor): Promise<number> {
    if (keyPrefix.length < 8) throw new Error('a cancel prefix names its messages');
    const done = await (tx ?? this.db).execute(sql`
      UPDATE sms_dispatches SET status = 'cancelled'
      WHERE status = 'scheduled' AND starts_with(idempotency_key, ${keyPrefix})
      RETURNING id
    `);
    return done.rows.length;
  }

  async markSent(dispatchId: string, providerMessageId: string | null): Promise<void> {
    await this.db.execute(sql`
      UPDATE sms_dispatches
      SET status = 'sent', sent_at = now(), provider_message_id = ${providerMessageId}
      WHERE id = ${dispatchId} AND status = 'pending'
    `);
  }

  /** The worker: the provider's delivery reports on what was sent in the last three days. */
  async pollDelivery(
    now = new Date(),
  ): Promise<{ checked: number; delivered: number; failed: number }> {
    const rows = (
      await this.db.execute(sql`
        SELECT id, provider_message_id FROM sms_dispatches
        WHERE status = 'sent' AND provider_message_id IS NOT NULL
          AND sent_at > ${new Date(now.getTime() - 3 * DAY_MS)}
        ORDER BY sent_at LIMIT 500
      `)
    ).rows;
    if (rows.length === 0) return { checked: 0, delivered: 0, failed: 0 };
    const states = await this.delivery.status(rows.map((r) => r['provider_message_id'] as string));
    let delivered = 0;
    let failed = 0;
    for (const r of rows) {
      const state = states.get(r['provider_message_id'] as string);
      if (state === 'delivered' || state === 'failed') {
        await this.db.execute(sql`
          UPDATE sms_dispatches
          SET status = ${state}, delivery_status = ${state}, delivery_checked_at = now()
          WHERE id = ${r['id'] as string} AND status = 'sent'
        `);
        if (state === 'delivered') delivered += 1;
        else failed += 1;
      }
    }
    this.logger.log(
      `sms delivery: ${String(rows.length)} checked, ${String(delivered)} delivered, ${String(failed)} failed`,
    );
    return { checked: rows.length, delivered, failed };
  }

  // --- templates --------------------------------------------------------------------------

  async templates(access: EffectiveAccess): Promise<SmsTemplateView[]> {
    this.require(access, TEMPLATES);
    const rows = await this.db.execute(sql`
      SELECT DISTINCT ON (code) id, code, version, audience, category, body, reason,
             ${iso('created_at')} AS created_at
      FROM sms_templates ORDER BY code, version DESC
    `);
    return (rows.rows as unknown as TemplateRow[]).map(view);
  }

  /** A new version of a template (or its first); refused with a field its recipient may not see. */
  async saveTemplate(
    actor: Actor,
    access: EffectiveAccess,
    input: {
      code: string;
      audience: SmsAudience;
      category: SmsCategory;
      body: string;
      reason: string;
    },
  ): Promise<SmsTemplateView> {
    this.require(access, TEMPLATES);
    const forbidden = forbiddenFields(input.audience, input.body);
    if (forbidden.length > 0) {
      throw new UnprocessableEntityException({
        error: 'template_field_not_allowed',
        fields: forbidden,
      });
    }
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`sms_template:${input.code}`}))`,
      );
      const last = await this.current(tx, input.code);
      // A code keeps its recipient and category: another one is another template.
      if (last && (last.audience !== input.audience || last.category !== input.category)) {
        throw new ConflictException({ error: 'template_kind_differs' });
      }
      const made = (
        await tx.execute(sql`
          INSERT INTO sms_templates (code, version, audience, category, body, reason, created_by)
          VALUES (${input.code}, ${(last?.version ?? 0) + 1}, ${input.audience}, ${input.category},
                  ${input.body}, ${input.reason}, ${actor.accountId})
          RETURNING id, code, version, audience, category, body, reason,
                    ${iso('created_at')} AS created_at
        `)
      ).rows[0] as unknown as TemplateRow;
      await this.audit.record(
        {
          actor,
          action: 'notification.template_saved',
          entityType: 'sms_template',
          entityId: made.id,
          before: last ? { version: last.version } : null,
          after: { code: made.code, version: made.version, fields: templateFields(made.body) },
          reason: input.reason,
        },
        tx,
      );
      return made;
    });
    return view(row);
  }

  // --- consent and the record -------------------------------------------------------------

  async setConsent(
    actor: Actor,
    access: EffectiveAccess,
    input: { mobile: string; action: 'consent' | 'withdraw'; reason: string },
    source: 'panel' | 'keyword' | 'link' = 'panel',
  ): Promise<{ mobileMasked: string; consent: 'consent' | 'withdraw' }> {
    this.require(access, CONSENT);
    const mobile = normalizeMobile(input.mobile);
    if (!mobile) throw new BadRequestException({ error: 'invalid_mobile' });
    await this.db.transaction(async (tx) => {
      const made = await tx.execute(sql`
        INSERT INTO sms_consents (mobile, action, source, reason, recorded_by)
        VALUES (${mobile}, ${input.action}, ${source}, ${input.reason}, ${actor.accountId})
        RETURNING id
      `);
      await this.audit.record(
        {
          actor,
          action: `notification.consent_${input.action}`,
          entityType: 'sms_consent',
          entityId: made.rows[0]?.['id'] as string,
          after: { mobile: mask(mobile), source },
          reason: input.reason,
        },
        tx,
      );
    });
    return { mobileMasked: mask(mobile), consent: input.action };
  }

  async recordConsent(
    actor: Actor,
    input: { mobile: string; source: 'wordpress' },
    tx?: SqlExecutor,
  ): Promise<void> {
    const mobile = normalizeMobile(input.mobile);
    if (!mobile) throw new BadRequestException({ error: 'invalid_mobile' });
    const run = async (ex: SqlExecutor) => {
      const made = await ex.execute(sql`
        INSERT INTO sms_consents (mobile, action, source, reason, recorded_by)
        VALUES (${mobile}, 'consent', ${input.source}, 'رضایت در فرم', ${actor.accountId})
        RETURNING id
      `);
      await this.audit.record(
        {
          actor,
          action: 'notification.consent_consent',
          entityType: 'sms_consent',
          entityId: made.rows[0]?.['id'] as string,
          after: { mobile: mask(mobile), source: input.source },
        },
        ex,
      );
    };
    if (tx) await run(tx);
    else await this.db.transaction(run);
  }

  async dispatches(
    access: EffectiveAccess,
    query: { status?: SmsDispatchStatus | undefined; templateCode?: string | undefined },
  ): Promise<SmsDispatchView[]> {
    this.require(access, DISPATCHES);
    const rows = await this.db.execute(sql`
      SELECT d.id, t.code, t.version, d.category, d.audience, d.mobile, d.segments,
             d.cost_estimate_rial::text AS cost, d.status, d.suppressed_reason,
             ${iso('d.send_after')} AS send_after, ${iso('d.sent_at')} AS sent_at,
             d.delivery_status, ${iso('d.created_at')} AS created_at,
             starts_with(d.idempotency_key, 'notification:scheduled:') AS staff_scheduled
      FROM sms_dispatches d JOIN sms_templates t ON t.id = d.template_id
      WHERE (${query.status ?? null}::text IS NULL OR d.status = ${query.status ?? null})
        AND (${query.templateCode ?? null}::text IS NULL OR t.code = ${query.templateCode ?? null})
      ORDER BY d.created_at DESC LIMIT 500
    `);
    return rows.rows.map((r) => ({
      id: r['id'] as string,
      templateCode: r['code'] as string,
      templateVersion: r['version'] as number,
      category: r['category'] as SmsCategory,
      audience: r['audience'] as SmsAudience,
      mobileMasked: mask(r['mobile'] as string),
      segments: r['segments'] as number,
      costEstimateRial: r['cost'] as string,
      status: r['status'] as SmsDispatchStatus,
      suppressedReason: (r['suppressed_reason'] as string | null) ?? null,
      sendAfter: r['send_after'] as string,
      sentAt: (r['sent_at'] as string | null) ?? null,
      deliveryStatus: (r['delivery_status'] as string | null) ?? null,
      staffScheduled: r['staff_scheduled'] === true,
      createdAt: r['created_at'] as string,
    }));
  }

  // --- helpers ----------------------------------------------------------------------------

  /** The newest version of a template (task 6-5: what a campaign or a scheduled SMS locks). */
  async templateOf(code: string, tx?: SqlExecutor): Promise<TemplateRow | null> {
    return this.current(tx ?? this.db, code);
  }

  /** One version, by its id, of this code. */
  private async version(ex: SqlExecutor, id: string, code: string): Promise<TemplateRow | null> {
    const row = (
      await ex.execute(sql`
        SELECT id, code, version, audience, category, body, reason,
               ${iso('created_at')} AS created_at
        FROM sms_templates WHERE id = ${id} AND code = ${code}
      `)
    ).rows[0];
    return (row as unknown as TemplateRow | undefined) ?? null;
  }

  /** Task 6-5: a mobile's consent to promotional SMS, as send() reads it. */
  consentState(mobile: string, tx?: SqlExecutor): Promise<'consent' | 'withdraw' | null> {
    return this.consentOf(tx ?? this.db, mobile);
  }

  private async current(ex: SqlExecutor, code: string): Promise<TemplateRow | null> {
    const row = (
      await ex.execute(sql`
        SELECT id, code, version, audience, category, body, reason,
               ${iso('created_at')} AS created_at
        FROM sms_templates WHERE code = ${code} ORDER BY version DESC LIMIT 1
      `)
    ).rows[0];
    return (row as unknown as TemplateRow | undefined) ?? null;
  }

  /** The newest consent row of a mobile: given, withdrawn, or none. */
  private async consentOf(ex: SqlExecutor, mobile: string): Promise<'consent' | 'withdraw' | null> {
    const row = (
      await ex.execute(sql`
        SELECT action FROM sms_consents WHERE mobile = ${mobile}
        ORDER BY created_at DESC, id DESC LIMIT 1
      `)
    ).rows[0];
    return (row?.['action'] as 'consent' | 'withdraw' | undefined) ?? null;
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}

function view(r: TemplateRow): SmsTemplateView {
  return {
    id: r.id,
    code: r.code,
    version: r.version,
    audience: r.audience,
    category: r.category,
    body: r.body,
    fields: templateFields(r.body),
    segments: smsSegments(r.body),
    reason: r.reason,
    createdAt: r.created_at,
  };
}
