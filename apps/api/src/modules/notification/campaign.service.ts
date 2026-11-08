import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  addJalaliDays,
  CAMPAIGN_FILTERS,
  formatToman,
  fromJalali,
  jalaliMomentToDate,
  normalizeMobile,
  parseJalaliDate,
  renderTemplate,
  smsSegments,
  templateFields,
  toPersianDigits,
  type CampaignAudience,
  type CampaignExclusion,
  type CampaignFilterCode,
  type CampaignPreview,
  type CampaignReport,
  type CampaignStatus,
  type CampaignView,
  type JalaliMoment,
  type PermissionCode,
  type SmsCategory,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CLI_ACTOR } from '../../common/auth/actor';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { BOOKING_PATIENTS, type BookingPatients } from '../../common/booking/booking-patients.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  BORROWER_SMS_HOLD,
  type BorrowerSmsHold,
} from '../../common/repayment/borrower-sms-hold.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';
import { NotificationService, type TemplateRow } from './notification.service';

const MANAGE: PermissionCode = 'notification.manage_campaigns';
const APPROVE: PermissionCode = 'notification.approve_campaigns';
const SCHEDULE: PermissionCode = 'notification.schedule_sms';
/** Technical: no more than this many recipients in one run's transaction. */
const BATCH_MAX = 1_000;
/** The worker's tick: the first batch of a campaign is this much of a minute's rate. */
const TICK_MS = 15_000;
const INSERT_CHUNK = 500;
const SCHEDULED_KEY = 'notification:scheduled:';

const iso = (c: string) =>
  sql.raw(`to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const mask = (mobile: string) => `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;

/** One person a filter found, before screening: their raw mobile and the fields filled. */
export interface CampaignCandidate {
  readonly personId: string | null;
  readonly mobile: string | null;
  readonly values: Readonly<Record<string, string>>;
}

interface Screened {
  recipients: { personId: string | null; mobile: string; values: Record<string, string> }[];
  excluded: Partial<Record<CampaignExclusion, number>>;
}

interface CampaignRow {
  id: string;
  name: string;
  audience: CampaignAudience;
  filter_code: CampaignFilterCode;
  filter_params: Record<string, unknown>;
  template_id: string;
  template_code: string;
  template_version: number;
  template_body: string;
  category: SmsCategory;
  status: CampaignStatus;
  two_person_threshold: number;
  recipient_count: number | null;
  excluded: Partial<Record<CampaignExclusion, number>> | null;
  cost: string | null;
  send_from: string;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  completed_at: string | null;
  last_batch_at: string | null;
}

const need = (access: EffectiveAccess, ...any: PermissionCode[]) => {
  if (!any.some((p) => access.permissions.has(p))) {
    throw new ForbiddenException({ error: 'permission_required', permission: any[0] });
  }
};

/**
 * Scheduled and bulk SMS (task 6-5; doc 15 §7; owner 1405/07/16):
 *
 * - one SMS at a chosen Jalali moment, cancellable while it waits;
 * - a campaign: a named filter (decision ت۸), a template version locked when made, a preview
 *   (count, exclusions, a real sample, the estimated price), approval always by a second
 *   person (above the locked threshold, only a holder of approve_campaigns), the recipients
 *   fixed in the approval's transaction, sent gradually by the worker at the configured
 *   rate, paused, resumed or stopped; each recipient one message;
 * - promotional campaigns behind a flag that is off until unsubscribing is built; the
 *   allowed hours and consent are 6-4's, applied by its send().
 *
 * The filters read other modules only through their ports; nothing here posts money.
 */
@Injectable()
export class CampaignService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    private readonly notifications: NotificationService,
    // Other modules' ports, wherever the app or the worker provides them; resolved when used.
    private readonly moduleRef: ModuleRef,
  ) {}

  private get leads(): LeadCases {
    return this.moduleRef.get<LeadCases>(LEAD_CASES, { strict: false });
  }

  private get hold(): BorrowerSmsHold {
    return this.moduleRef.get<BorrowerSmsHold>(BORROWER_SMS_HOLD, { strict: false });
  }

  private get repayment(): RepaymentPort {
    return this.moduleRef.get<RepaymentPort>(REPAYMENT, { strict: false });
  }

  private get wallet(): WalletPort {
    return this.moduleRef.get<WalletPort>(WALLET, { strict: false });
  }

  private get facts(): CreditContractFactsPort {
    return this.moduleRef.get<CreditContractFactsPort>(CREDIT_CONTRACT_FACTS, { strict: false });
  }

  private get patients(): BookingPatients {
    return this.moduleRef.get<BookingPatients>(BOOKING_PATIENTS, { strict: false });
  }

  private get outbox(): OutboxPort {
    return this.moduleRef.get<OutboxPort>(OUTBOX, { strict: false });
  }

  // --- one scheduled SMS ------------------------------------------------------------------

  async schedule(
    actor: Actor,
    access: EffectiveAccess,
    input: {
      templateCode: string;
      personId?: string | undefined;
      mobile?: string | undefined;
      values: Record<string, string>;
      sendAt: JalaliMoment;
      reason: string;
    },
    now = new Date(),
  ): Promise<{ dispatchId: string; status: string; sendAfter: string }> {
    need(access, SCHEDULE);
    const template = await this.notifications.templateOf(input.templateCode);
    if (!template) throw new NotFoundException({ error: 'template_not_found' });
    await this.checkCategory(template, now, 'urgent_not_schedulable');
    const sendAt = jalaliMomentToDate(input.sendAt);
    if (sendAt <= now) throw new BadRequestException({ error: 'send_at_past' });
    const missing = templateFields(template.body).filter((f) => input.values[f] === undefined);
    if (missing.length > 0) {
      throw new BadRequestException({ error: 'template_value_missing', fields: missing });
    }
    let mobile: string | null;
    if (input.personId !== undefined) {
      mobile = await this.leads.mobileOf(input.personId);
      if (!mobile) throw new ConflictException({ error: 'no_mobile' });
      if (await this.hold.isHeld(input.personId)) {
        throw new ConflictException({ error: 'recipient_held' });
      }
    } else {
      // A raw number only for staff: anyone else is named by their person.
      if (template.audience !== 'staff')
        throw new BadRequestException({ error: 'person_required' });
      mobile = normalizeMobile(input.mobile ?? '');
      if (!mobile) throw new BadRequestException({ error: 'invalid_mobile' });
    }
    const values = Object.fromEntries(
      templateFields(template.body).map((f) => [f, input.values[f] as string]),
    );
    return this.db.transaction(async (tx) => {
      const sent = await this.notifications.send(
        {
          templateCode: template.code,
          templateId: template.id,
          audience: template.audience,
          mobile,
          personId: input.personId ?? null,
          values,
          idempotencyKey: `${SCHEDULED_KEY}${randomUUID()}`,
          sendAfter: sendAt,
        },
        tx,
        now,
      );
      const row = (
        await tx.execute(sql`
          SELECT ${iso('send_after')} AS send_after FROM sms_dispatches WHERE id = ${sent.dispatchId}
        `)
      ).rows[0];
      await this.audit.record(
        {
          actor,
          action: 'notification.sms_scheduled',
          entityType: 'sms_dispatch',
          entityId: sent.dispatchId,
          after: {
            template: template.code,
            version: template.version,
            mobile: mask(mobile),
            sendAt: sendAt.toISOString(),
            status: sent.status,
          },
          reason: input.reason,
        },
        tx,
      );
      return {
        dispatchId: sent.dispatchId,
        status: sent.status,
        sendAfter: row?.['send_after'] as string,
      };
    });
  }

  /** Cancelled while it still waits for its moment; once released, 409 (task 6-5). */
  async cancelScheduledSms(
    actor: Actor,
    access: EffectiveAccess,
    dispatchId: string,
    reason: string,
  ): Promise<{ dispatchId: string; status: 'cancelled' }> {
    need(access, SCHEDULE);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.execute(sql`
          SELECT id, status, idempotency_key FROM sms_dispatches
          WHERE id = ${dispatchId} FOR UPDATE
        `)
      ).rows[0];
      // Only a scheduled SMS of this kind: never a reminder or another module's message.
      if (!row || !(row['idempotency_key'] as string).startsWith(SCHEDULED_KEY)) {
        throw new NotFoundException({ error: 'scheduled_sms_not_found' });
      }
      if (row['status'] !== 'scheduled') {
        throw new ConflictException({ error: 'not_cancellable', status: row['status'] });
      }
      await tx.execute(
        sql`UPDATE sms_dispatches SET status = 'cancelled' WHERE id = ${dispatchId}`,
      );
      await this.audit.record(
        {
          actor,
          action: 'notification.sms_schedule_cancelled',
          entityType: 'sms_dispatch',
          entityId: dispatchId,
          before: { status: 'scheduled' },
          after: { status: 'cancelled' },
          reason,
        },
        tx,
      );
      return { dispatchId, status: 'cancelled' as const };
    });
  }

  // --- campaigns ----------------------------------------------------------------------------

  async create(
    actor: Actor,
    access: EffectiveAccess,
    input: {
      name: string;
      filterCode: CampaignFilterCode;
      filterParams: Record<string, unknown>;
      templateCode: string;
      sendFrom?: JalaliMoment | undefined;
    },
    now = new Date(),
  ): Promise<CampaignView> {
    need(access, MANAGE);
    if (!actor.accountId) throw new ForbiddenException({ error: 'staff_only' });
    const filter = CAMPAIGN_FILTERS[input.filterCode];
    const params = filter.params.safeParse(input.filterParams);
    if (!params.success) {
      throw new BadRequestException({
        error: 'invalid_filter_params',
        issues: params.error.issues,
      });
    }
    const template = await this.notifications.templateOf(input.templateCode);
    if (!template) throw new NotFoundException({ error: 'template_not_found' });
    if (template.audience !== filter.audience) {
      throw new ConflictException({ error: 'template_audience_differs' });
    }
    await this.checkCategory(template, now, 'campaign_category_not_allowed');
    const fields: readonly string[] = filter.fields;
    const unavailable = templateFields(template.body).filter((f) => !fields.includes(f));
    if (unavailable.length > 0) {
      throw new ConflictException({ error: 'template_field_unavailable', fields: unavailable });
    }
    const threshold = await this.config.resolve('notification.bulk_two_person_threshold', {}, now);
    const sendFrom = input.sendFrom ? jalaliMomentToDate(input.sendFrom) : now;
    const id = await this.db.transaction(async (tx) => {
      const made = (
        await tx.execute(sql`
          INSERT INTO sms_campaigns (name, audience, filter_code, filter_params, template_id,
                                     category, two_person_threshold, send_from, created_by)
          VALUES (${input.name}, ${filter.audience}, ${input.filterCode},
                  ${JSON.stringify(params.data)}::jsonb, ${template.id}, ${template.category},
                  ${threshold.value}, ${sendFrom < now ? now : sendFrom}, ${actor.accountId})
          RETURNING id
        `)
      ).rows[0]?.['id'] as string;
      await this.audit.record(
        {
          actor,
          action: 'notification.campaign_created',
          entityType: 'sms_campaign',
          entityId: made,
          after: {
            filter: input.filterCode,
            params: params.data,
            template: template.code,
            version: template.version,
            threshold: threshold.value,
          },
        },
        tx,
      );
      return made;
    });
    return this.view(await this.campaign(this.db, id));
  }

  async list(access: EffectiveAccess): Promise<CampaignView[]> {
    need(access, MANAGE, APPROVE);
    const rows = await this.db.execute(sql`
      ${this.select()} ORDER BY c.created_at DESC, c.id DESC LIMIT 200
    `);
    return (rows.rows as unknown as CampaignRow[]).map((r) => this.view(r));
  }

  /** Who would get it now, who would not and why, a real sample and the price; nothing kept. */
  async preview(access: EffectiveAccess, id: string, now = new Date()): Promise<CampaignPreview> {
    need(access, MANAGE, APPROVE);
    const c = await this.campaign(this.db, id);
    const screened = await this.screen(c, await this.candidates(c, now));
    const price = await this.config.resolve('notification.segment_cost_rial', {}, now);
    const { segments, cost } = this.estimate(c.template_body, screened, BigInt(price.value));
    const first = screened.recipients[0];
    return {
      recipientCount: screened.recipients.length,
      excluded: screened.excluded,
      sample: first ? renderTemplate(c.template_body, first.values) : null,
      segments,
      costEstimateRial: cost.toString(),
      twoPersonThreshold: c.two_person_threshold,
      needsApproveCampaigns: screened.recipients.length > c.two_person_threshold,
    };
  }

  /**
   * Owner (ج): always a second person. At or below the campaign's locked threshold, any
   * holder of manage_campaigns or approve_campaigns; above it, only approve_campaigns. The
   * filter runs again here and its recipients are fixed in this transaction (test 8).
   */
  async approve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    now = new Date(),
  ): Promise<CampaignView> {
    need(access, MANAGE, APPROVE);
    await this.db.transaction(async (tx) => {
      const c = await this.campaign(tx, id, true);
      if (c.status !== 'draft') throw new ConflictException({ error: 'campaign_not_draft' });
      if (c.created_by === actor.accountId) throw new ConflictException({ error: 'same_person' });
      if (c.category === 'promotional' && !(await this.promotionalOn(now))) {
        throw new ConflictException({ error: 'promotional_campaigns_off' });
      }
      const screened = await this.screen(c, await this.candidates(c, now), tx);
      const count = screened.recipients.length;
      if (count === 0) throw new ConflictException({ error: 'no_recipients' });
      if (count > c.two_person_threshold && !access.permissions.has(APPROVE)) {
        throw new ForbiddenException({ error: 'permission_required', permission: APPROVE });
      }
      for (let i = 0; i < count; i += INSERT_CHUNK) {
        const chunk = screened.recipients.slice(i, i + INSERT_CHUNK);
        await tx.execute(sql`
          INSERT INTO sms_campaign_recipients (campaign_id, person_id, mobile, values)
          VALUES ${sql.join(
            chunk.map(
              (r) => sql`(${id}, ${r.personId}, ${r.mobile}, ${JSON.stringify(r.values)}::jsonb)`,
            ),
            sql`, `,
          )}
        `);
      }
      const price = await this.config.resolve('notification.segment_cost_rial', {}, now);
      const { cost } = this.estimate(c.template_body, screened, BigInt(price.value));
      await tx.execute(sql`
        UPDATE sms_campaigns
        SET status = 'sending', recipient_count = ${count},
            excluded = ${JSON.stringify(screened.excluded)}::jsonb, cost_estimate_rial = ${cost},
            approved_by = ${actor.accountId}, approved_at = ${now}
        WHERE id = ${id}
      `);
      await this.outbox.publish(
        {
          type: 'sms.campaign_approved',
          aggregateType: 'sms_campaign',
          aggregateId: id,
          payload: { campaignId: id, recipientCount: count, templateId: c.template_id },
        },
        tx,
      );
      await this.audit.record(
        {
          actor,
          action: 'notification.campaign_approved',
          entityType: 'sms_campaign',
          entityId: id,
          before: { status: 'draft' },
          after: {
            status: 'sending',
            filter: c.filter_code,
            params: c.filter_params,
            template: c.template_code,
            version: c.template_version,
            recipients: count,
            excluded: screened.excluded,
            threshold: c.two_person_threshold,
          },
        },
        tx,
      );
    });
    return this.view(await this.campaign(this.db, id));
  }

  pause(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    return this.move(actor, access, id, ['sending'], 'paused', reason);
  }

  resume(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    return this.move(actor, access, id, ['paused'], 'sending', reason);
  }

  cancel(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    return this.move(actor, access, id, ['draft'], 'cancelled', reason);
  }

  /** What is left is cancelled; what waits for the allowed hours in 6-4 is cancelled too. */
  stop(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    return this.move(actor, access, id, ['sending', 'paused'], 'stopped', reason);
  }

  async report(access: EffectiveAccess, id: string): Promise<CampaignReport> {
    need(access, MANAGE, APPROVE);
    const c = await this.campaign(this.db, id);
    const [recipients, dispatches] = await Promise.all([
      this.db.execute(sql`
        SELECT status, count(*)::int AS n FROM sms_campaign_recipients
        WHERE campaign_id = ${id} GROUP BY status
      `),
      this.db.execute(sql`
        SELECT d.status, count(*)::int AS n
        FROM sms_campaign_recipients r JOIN sms_dispatches d ON d.id = r.dispatch_id
        WHERE r.campaign_id = ${id} GROUP BY d.status
      `),
    ]);
    const by = (rows: Record<string, unknown>[]) =>
      Object.fromEntries(rows.map((r) => [r['status'] as string, r['n'] as number]));
    const r = by(recipients.rows);
    return {
      recipients: {
        pending: r['pending'] ?? 0,
        dispatched: r['dispatched'] ?? 0,
        cancelled: r['cancelled'] ?? 0,
      },
      dispatches: by(dispatches.rows),
      excluded: c.excluded,
    };
  }

  /**
   * The worker, every 15 seconds: each sending campaign whose moment has come takes its share
   * of the rate since its last batch (at most a minute's), under its row's lock, so two
   * workers never send one campaign twice or faster. Each recipient goes through 6-4's send()
   * once, by its key; one held since approval is skipped. Nothing left: completed.
   */
  async run(now = new Date()): Promise<{ dispatched: number; completed: number }> {
    const rate = (await this.config.resolve('notification.campaign_batch_per_minute', {}, now))
      .value;
    const due = await this.db.execute(sql`
      SELECT id FROM sms_campaigns
      WHERE status = 'sending' AND send_from <= ${now}
      ORDER BY approved_at, id
    `);
    let dispatched = 0;
    let completed = 0;
    for (const d of due.rows) {
      const done = await this.batch(d['id'] as string, rate, now);
      dispatched += done.dispatched;
      if (done.completed) completed += 1;
    }
    return { dispatched, completed };
  }

  // --- helpers ----------------------------------------------------------------------------

  private async batch(
    id: string,
    rate: number,
    now: Date,
  ): Promise<{ dispatched: number; completed: boolean }> {
    return this.db.transaction(async (tx) => {
      const locked = (
        await tx.execute(sql`
          SELECT c.id, c.audience, c.template_id, t.code AS template_code, c.last_batch_at
          FROM sms_campaigns c JOIN sms_templates t ON t.id = c.template_id
          WHERE c.id = ${id} AND c.status = 'sending'
          FOR UPDATE OF c SKIP LOCKED
        `)
      ).rows[0];
      if (!locked) return { dispatched: 0, completed: false };
      const last = locked['last_batch_at'] as string | null;
      const elapsed = last ? now.getTime() - new Date(last).getTime() : TICK_MS;
      const size = Math.min(BATCH_MAX, Math.floor((rate * Math.min(60_000, elapsed)) / 60_000));
      let dispatched = 0;
      if (size > 0) {
        const rows = (
          await tx.execute(sql`
            SELECT id, person_id, mobile, values FROM sms_campaign_recipients
            WHERE campaign_id = ${id} AND status = 'pending'
            ORDER BY id LIMIT ${size}
          `)
        ).rows;
        for (const r of rows) {
          const personId = (r['person_id'] as string | null) ?? null;
          if (personId && (await this.hold.isHeld(personId, tx))) {
            await tx.execute(sql`
              UPDATE sms_campaign_recipients SET status = 'cancelled', cancel_reason = 'held'
              WHERE id = ${r['id'] as string}
            `);
            continue;
          }
          const mobile = r['mobile'] as string;
          const sent = await this.notifications.send(
            {
              templateCode: locked['template_code'] as string,
              templateId: locked['template_id'] as string,
              audience: locked['audience'] as CampaignAudience,
              mobile,
              personId,
              values: r['values'] as Record<string, string>,
              idempotencyKey: `campaign:${id}:${mobile}`,
            },
            tx,
            now,
          );
          await tx.execute(sql`
            UPDATE sms_campaign_recipients SET status = 'dispatched', dispatch_id = ${sent.dispatchId}
            WHERE id = ${r['id'] as string}
          `);
          dispatched += 1;
        }
        await tx.execute(sql`UPDATE sms_campaigns SET last_batch_at = ${now} WHERE id = ${id}`);
      }
      const left = (
        await tx.execute(sql`
          SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                 count(*) FILTER (WHERE status = 'dispatched')::int AS dispatched,
                 count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
          FROM sms_campaign_recipients WHERE campaign_id = ${id}
        `)
      ).rows[0] as { pending: number; dispatched: number; cancelled: number };
      if (left.pending > 0) return { dispatched, completed: false };
      await tx.execute(sql`
        UPDATE sms_campaigns SET status = 'completed', completed_at = ${now} WHERE id = ${id}
      `);
      await this.outbox.publish(
        {
          type: 'sms.campaign_completed',
          aggregateType: 'sms_campaign',
          aggregateId: id,
          payload: { campaignId: id, dispatched: left.dispatched, cancelled: left.cancelled },
        },
        tx,
      );
      await this.audit.record(
        {
          actor: CLI_ACTOR,
          action: 'notification.campaign_completed',
          entityType: 'sms_campaign',
          entityId: id,
          before: { status: 'sending' },
          after: { status: 'completed', dispatched: left.dispatched, cancelled: left.cancelled },
        },
        tx,
      );
      return { dispatched, completed: true };
    });
  }

  private async move(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    from: readonly CampaignStatus[],
    to: CampaignStatus,
    reason: string,
  ): Promise<CampaignView> {
    need(access, MANAGE);
    await this.db.transaction(async (tx) => {
      const c = await this.campaign(tx, id, true);
      if (!from.includes(c.status)) {
        throw new ConflictException({ error: 'campaign_status', status: c.status });
      }
      if (to === 'stopped' || to === 'cancelled') {
        await tx.execute(sql`
          UPDATE sms_campaigns
          SET status = ${to}, stopped_by = ${actor.accountId}, stopped_at = now(),
              stop_reason = ${reason}
          WHERE id = ${id}
        `);
      } else {
        await tx.execute(sql`UPDATE sms_campaigns SET status = ${to} WHERE id = ${id}`);
      }
      let cancelled = 0;
      if (to === 'stopped') {
        cancelled = (
          await tx.execute(sql`
            UPDATE sms_campaign_recipients SET status = 'cancelled', cancel_reason = 'stopped'
            WHERE campaign_id = ${id} AND status = 'pending' RETURNING id
          `)
        ).rows.length;
        // Recorded in 6-4 but still waiting for the allowed hours: never sent now.
        await this.notifications.cancelScheduled(`campaign:${id}:`, tx);
      }
      await this.audit.record(
        {
          actor,
          action: `notification.campaign_${to === 'sending' ? 'resumed' : to}`,
          entityType: 'sms_campaign',
          entityId: id,
          before: { status: c.status },
          after: to === 'stopped' ? { status: to, cancelled } : { status: to },
          reason,
        },
        tx,
      );
    });
    return this.view(await this.campaign(this.db, id));
  }

  /** Urgent never (it skips the allowed hours); promotional only with the flag on (owner). */
  private async checkCategory(template: TemplateRow, now: Date, urgentError: string) {
    if (template.category === 'urgent') throw new ConflictException({ error: urgentError });
    if (template.category === 'promotional' && !(await this.promotionalOn(now))) {
      throw new ConflictException({ error: 'promotional_campaigns_off' });
    }
  }

  private async promotionalOn(now: Date): Promise<boolean> {
    return (await this.config.resolve('notification.promotional_campaigns_enabled', {}, now)).value;
  }

  /** The named filter, through the owning modules' ports (decision ت۸). */
  async candidates(c: CampaignRow, now: Date): Promise<CampaignCandidate[]> {
    const nameOf = async (personId: string | null, fallback: string) =>
      (personId ? await this.leads.displayNameOf(personId) : null) ?? fallback;
    const params = c.filter_params;
    switch (c.filter_code) {
      case 'borrowers_overdue_at_least':
      case 'guarantors_overdue_at_least': {
        const days = params['days'] as number;

        const overdue = (await this.repayment.overdueCases(now)).filter(
          (o) => o.maxDaysPastDue >= days,
        );
        const out: CampaignCandidate[] = [];
        for (const o of overdue) {
          const borrower = await this.borrowerOf(o.purseIds[0]);
          if (!borrower) continue;
          const name = await nameOf(borrower.personId, 'مشتری');
          const common = {
            days_overdue: toPersianDigits(o.maxDaysPastDue),
            amount: formatToman(o.overdueRial),
          };
          if (c.filter_code === 'borrowers_overdue_at_least') {
            out.push({
              personId: borrower.personId,
              mobile: await this.leads.mobileOf(borrower.personId),
              values: { name, ...common },
            });
            continue;
          }
          if (!borrower.creditApplicationId) continue;
          const facts = await this.facts.facts(borrower.creditApplicationId);
          for (const g of facts?.guarantors ?? []) {
            out.push({
              personId: g.personId,
              mobile: await this.leads.mobileOf(g.personId),
              values: { name: await nameOf(g.personId, 'ضامن'), borrower_name: name, ...common },
            });
          }
        }
        return out;
      }
      case 'borrowers_active': {
        const active = await this.repayment.activeCases();
        const out: CampaignCandidate[] = [];
        for (const a of active) {
          const borrower = await this.borrowerOf(a.purseIds[0]);
          if (!borrower) continue;
          out.push({
            personId: borrower.personId,
            mobile: await this.leads.mobileOf(borrower.personId),
            values: { name: await nameOf(borrower.personId, 'مشتری') },
          });
        }
        return out;
      }
      case 'patients_of_center': {
        const day = (d: unknown) => (typeof d === 'string' ? parseJalaliDate(d) : null);
        const from = day(params['from']);
        const to = day(params['to']);
        const patients = await this.patients.patientsAt(params['workplaceIds'] as string[], {
          from: from ? fromJalali(from) : null,
          // To the end of that Tehran day.
          to: to ? fromJalali(addJalaliDays(to, 1)) : null,
        });
        const out: CampaignCandidate[] = [];
        for (const p of patients) {
          out.push({
            personId: p.personId,
            mobile: p.mobile,
            values: { name: await nameOf(p.personId, 'بیمار') },
          });
        }
        return out;
      }
    }
  }

  private async borrowerOf(purseId: string | undefined) {
    if (!purseId) return null;
    const purse = await this.wallet.summary(purseId);
    return { personId: purse.borrowerPersonId, creditApplicationId: purse.creditApplicationId };
  }

  /** Without a mobile, held, without consent to a promotional one, or a mobile seen already. */
  private async screen(
    c: CampaignRow,
    candidates: readonly CampaignCandidate[],
    tx?: SqlExecutor,
  ): Promise<Screened> {
    const excluded: Partial<Record<CampaignExclusion, number>> = {};
    const out = (why: CampaignExclusion) => {
      excluded[why] = (excluded[why] ?? 0) + 1;
    };
    const seen = new Set<string>();
    const recipients: Screened['recipients'] = [];
    for (const cand of candidates) {
      const mobile = cand.mobile ? normalizeMobile(cand.mobile) : null;
      if (!mobile) {
        out('no_mobile');
        continue;
      }
      if (cand.personId && (await this.hold.isHeld(cand.personId, tx))) {
        out('held');
        continue;
      }
      if (c.category === 'promotional') {
        const consent = await this.notifications.consentState(mobile, tx);
        if (consent !== 'consent') {
          out(consent === 'withdraw' ? 'unsubscribed' : 'no_consent');
          continue;
        }
      }
      if (seen.has(mobile)) {
        out('duplicate_mobile');
        continue;
      }
      seen.add(mobile);
      recipients.push({ personId: cand.personId, mobile, values: { ...cand.values } });
    }
    return { recipients, excluded };
  }

  private estimate(body: string, screened: Screened, price: bigint) {
    let segments = 0;
    for (const r of screened.recipients) segments += smsSegments(renderTemplate(body, r.values));
    return { segments, cost: BigInt(segments) * price };
  }

  private select() {
    return sql`
      SELECT c.id, c.name, c.audience, c.filter_code, c.filter_params, c.template_id,
             t.code AS template_code, t.version AS template_version, t.body AS template_body,
             c.category, c.status, c.two_person_threshold, c.recipient_count, c.excluded,
             c.cost_estimate_rial::text AS cost, ${iso('c.send_from')} AS send_from,
             c.created_by, ${iso('c.created_at')} AS created_at, c.approved_by,
             ${iso('c.approved_at')} AS approved_at, ${iso('c.completed_at')} AS completed_at,
             c.last_batch_at
      FROM sms_campaigns c JOIN sms_templates t ON t.id = c.template_id
    `;
  }

  private async campaign(ex: SqlExecutor, id: string, lock = false): Promise<CampaignRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException({ error: 'campaign_not_found' });
    const row = (
      await ex.execute(sql`
        ${this.select()} WHERE c.id = ${id} ${lock ? sql`FOR UPDATE OF c` : sql``}
      `)
    ).rows[0] as CampaignRow | undefined;
    if (!row) throw new NotFoundException({ error: 'campaign_not_found' });
    return row;
  }

  private view(r: CampaignRow): CampaignView {
    return {
      id: r.id,
      name: r.name,
      audience: r.audience,
      filterCode: r.filter_code,
      filterParams: r.filter_params,
      templateCode: r.template_code,
      templateVersion: r.template_version,
      category: r.category,
      status: r.status,
      twoPersonThreshold: r.two_person_threshold,
      recipientCount: r.recipient_count,
      excluded: r.excluded,
      costEstimateRial: r.cost,
      sendFrom: r.send_from,
      createdBy: r.created_by,
      createdAt: r.created_at,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      completedAt: r.completed_at,
    };
  }
}
