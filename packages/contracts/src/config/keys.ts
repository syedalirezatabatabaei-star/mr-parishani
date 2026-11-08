import { collectionBucketsSchema, escalationRulesSchema } from '../collection/index.js';
import { ticketTopicsSchema } from '../ticket/index.js';
import { allowedHoursSchema } from '../notification/sms.js';
import { providerContractSchema, serviceFeeRateSchema } from '../settlement/fees.js';
import * as z from 'zod';
import { WEEKDAYS } from '../jalali/working-days.js';
import { holidayRulesSchema } from './holiday-suggestions.js';
import { creditDocumentChecklistSchema, creditDocumentPolicySchema } from '../credit/documents.js';
import {
  creditCommitteeUnitsSchema,
  creditDecisionSmsTemplatesSchema,
  creditRejectionReasonsSchema,
} from '../credit/decisions.js';
import { contractTemplateSchema } from '../contract/contracts.js';
import { creditPlansSchema } from '../credit/plans.js';
import { instrumentSmsTemplatesSchema } from '../instrument/instruments.js';
import { scoringRulesetSchema } from '../scoring/ruleset.js';
import { serviceSmsTemplatesSchema } from '../service/authorizations.js';
import { purseTitleSchema, walletSmsTemplatesSchema } from '../wallet/funding.js';
import { normalizePersianText } from '../text/persian.js';

/**
 * Versioned configuration (ADR-006, task 0-6). Keys are code: each names its value's
 * schema, the levels it may be set at, who manages it and whether a change needs two
 * people. Values are data in `config_values`, read only through the config module's
 * resolve(). Adding a key also needs a migration that registers it in `config_keys` and
 * seeds its global value: the API refuses to start otherwise.
 *
 * Values never hold floating-point numbers (rule 1): money is a string of whole rials,
 * a rate an integer of basis points (1800 = 18%), a duration whole seconds or days.
 */

/**
 * Where a value applies, from the most general to the most specific (ADR-010). One level
 * per value; the most specific level with a value wins.
 */
export const CONFIG_LEVELS = ['global', 'city', 'treatment_field', 'center', 'doctor'] as const;
export type ConfigLevel = (typeof CONFIG_LEVELS)[number];

export type ConfigCategory = 'business' | 'technical';

export interface KeyDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly levels: readonly ConfigLevel[];
  /** business: config.manage_business; technical: config.manage_technical. */
  readonly category: ConfigCategory;
  /** A change needs a second person to approve it (doc 04 §5). */
  readonly sensitive: boolean;
}

const define = <S extends z.ZodType>(definition: KeyDefinition<S>) => definition;

const seconds = z.number().int().min(1);
const count = z.number().int().min(1);
const rial = z.string().regex(/^[1-9][0-9]{0,17}$/);
const cidr = z
  .string()
  .trim()
  .refine((value) => z.cidrv4().safeParse(value).success || z.cidrv6().safeParse(value).success, {
    message: 'not a CIDR block',
  });

/** One SMS text; the provider splits long ones, so keep it to a few parts. */
const smsText = z.string().min(5).max(480);

const checklistItem = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  title: z.string().min(2).max(200),
});

/**
 * Every configuration key. All are sensitive for now (task 0-6 decision): every change is
 * approved by a second person.
 */
export const CONFIG_KEYS = {
  // identity: login limits and lifetimes (formerly IDENTITY_POLICY)
  'identity.otp': define({
    schema: z.object({
      /** SMS delivery in Iran is sometimes slow, so a code lives a few minutes. */
      ttlSeconds: seconds,
      /** A new code for the same mobile no sooner than this. */
      resendCooldownSeconds: seconds,
      sendsPerMobilePerHour: count,
      sendsPerIpPerHour: count,
      sendsPerDevicePerHour: count,
      /** Wrong codes for one mobile before it is locked. */
      failuresBeforeLock: count,
      /** Wrong codes from one IP per hour, across all mobiles. */
      failuresPerIpPerHour: count,
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  'identity.staff_login': define({
    schema: z.object({
      /** Wrong passwords (or, counted apart, TOTP codes) before the username is locked. */
      failuresBeforeLock: count,
      failuresPerIpPerHour: count,
      minPasswordLength: z.number().int().min(12),
      /** A password-verified session that has not passed TOTP yet. */
      pendingMfaTtlSeconds: seconds,
      /** A TOTP reset request expires without a second person. */
      totpResetRequestTtlSeconds: seconds,
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  'identity.lockout': define({
    schema: z.object({
      /** Temporary lock after too many failures (OTP and staff alike). */
      lockSeconds: seconds,
      /** Counting window for consecutive failures before a lock. */
      failureWindowSeconds: seconds,
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * Task 9-3 (R5; ASVS 11.1.4): every public endpoint, per client address and minute. The
   * search, the login code and the lead webhook keep their own tighter limits besides.
   */
  'identity.public_rate_limit': define({
    schema: z.object({ perIpPerMinute: count }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * Task 9-3 (R1; ASVS 3.7.1, 4.3.3): a sensitive action (roles, TOTP resets, configuration)
   * needs a TOTP code given in this session within `windowSeconds`. Off until go-live (م۴).
   */
  'identity.reauth': define({
    schema: z.object({ enabled: z.boolean(), windowSeconds: seconds }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * ADR-052 (owner 1405/08/02): the SMS one-time code that confirms each financial approval.
   * Its numbers are the owner's; there is no off: without a code no financial approval goes.
   */
  'identity.financial_step_up': define({
    schema: z.strictObject({
      /**
       * Owner 1405/08/03: off until the second Kavenegar template works in production, a test
       * SMS has arrived and every signer has a verified mobile; turned on by two people. While
       * off, financial approvals need no code.
       */
      enabled: z.boolean(),
      codeTtlSeconds: z.number().int().min(30).max(900),
      maxAttempts: z.number().int().min(1).max(20),
      lockoutSeconds: z.number().int().min(60).max(86_400),
      resendAfterSeconds: z.number().int().min(10).max(3_600),
      maxSendsPerHour: z.number().int().min(1).max(60),
      /** A signer's new mobile takes effect this long after the second approval. */
      mobileChangeDelayHours: z.number().int().min(0).max(720),
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** Task 9-3 (R2; ASVS 2.2.3, 2.5.5): an SMS when a login factor changes. Off until go-live. */
  'identity.factor_change_sms': define({
    schema: z.object({ enabled: z.boolean() }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * Task 9-3 (owner, question 3): an internal staff member proves a mobile at the next sign-in
   * before anything else; no account is locked. Off until go-live.
   */
  'identity.staff_mobile_required': define({
    schema: z.object({ enabled: z.boolean() }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * ف۱۲ (owner 1405/07/26, option «ب»): a patient replaces their login mobile by a code sent
   * to the new one. Off until go-live. Only from a sign-in this recent (an active login), and
   * no sooner than `cooldownDays` after the last change (0: no wait). A staff request for a
   * lost mobile (ب۲) not decided within `staffRequestDays` expires (owner 1405/07/27: 7 days;
   * 0: never), by the value in force when it was proposed.
   */
  'identity.patient_mobile_change': define({
    schema: z.object({
      enabled: z.boolean(),
      recentLoginSeconds: seconds,
      cooldownDays: z.number().int().min(0).max(365),
      staffRequestDays: z.number().int().min(0).max(365).default(7),
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  'identity.session': define({
    schema: z.object({
      /** Web session: expires after this long without activity. */
      webIdleSeconds: seconds,
      /** Mobile access token lifetime. */
      accessTokenSeconds: seconds,
      /** Mobile refresh token lifetime; each use issues a new one. */
      refreshTokenSeconds: seconds,
      /**
       * Task 9-3 (R1; ASVS 3.3.2 level 2): a web session ends this long after its sign-in,
       * however active; signing in again is required. Default 12 hours.
       */
      webAbsoluteSeconds: seconds.default(43_200),
      /** The same for a mobile session: no refresh past it. Default 30 days. */
      mobileAbsoluteSeconds: seconds.default(2_592_000),
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  // access and audit (formerly access_policy_versions)
  /** The internal panel only answers staff from these networks (office, VPN), when enabled. */
  'access.internal_panel_ip_allowlist': define({
    schema: z.object({ enabled: z.boolean(), cidrs: z.array(cidr).max(100) }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * R4 (task 9-3; owner 1405/07/18): one run of the field re-encryption tool, allowed by two
   * people until `until`; null allows none. The tool takes each approval once.
   */
  'audit.field_reencryption': define({
    schema: z.object({ until: z.iso.datetime({ offset: true }).nullable() }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** Months of audit and access-log partitions kept attached before being archived. */
  'audit.retention': define({
    schema: z.object({ months: z.number().int().min(1).max(600) }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  // ops: operating the platform itself (task 0-7); not a module, hence the prefix
  /** Alert when the outbox holds more unpublished events, or the oldest waits longer. */
  'ops.outbox_alert_thresholds': define({
    schema: z.object({ maxPending: count, maxOldestPendingSeconds: seconds }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** Alert when any queue has more jobs waiting, or more failed jobs, than this. */
  'ops.queue_alert_thresholds': define({
    schema: z.object({ maxWaiting: count, maxFailed: z.number().int().min(0) }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** Months of outbox and processed-event partitions kept attached before archiving. */
  'ops.outbox_retention': define({
    schema: z.object({ months: z.number().int().min(1).max(600) }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** Alert when a posted journal has not reached account_balances after this long. */
  'ops.ledger_lag_alert': define({
    schema: z.object({ maxUnappliedSeconds: seconds }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  // calendar: the shared working-day rules (task 2-1); not a module, hence the prefix
  /**
   * Days of the week that are never working days (task 2-1 decision: Friday). Whether
   * Thursday is one too is for company accounting to say; this key changes it, not code.
   */
  'calendar.weekly_days_off': define({
    schema: z
      .array(z.enum(WEEKDAYS))
      .max(WEEKDAYS.length - 1)
      .refine((days) => new Set(days).size === days.length, { message: 'repeated day' }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The official holidays the panel suggests for a year (owner 1405/07/23, plan 3; ADR-043):
   * fixed solar days, and lunar days estimated offline. Only a preview: nothing is a holiday
   * until the admin saves it. Seeded with the fixed solar days only (owner 1405/07/24,
   * migration 0088); lunar days are entered after the official announcement. TODO(decision):
   * Aramesh Sarvat's accounting or legal confirms the list.
   */
  'calendar.holiday_rules': define({
    schema: holidayRulesSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  // catalog (task 2-2)
  /**
   * The documents a center must provide before review, by person type. Only statuses for
   * now; files come with task 2-8. TODO(decision): the list itself.
   */
  'catalog.center_document_checklist': define({
    schema: z.object({
      natural: z.array(checklistItem).max(30),
      legal: z.array(checklistItem).max(30),
    }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  // booking (task 2-5)
  /**
   * How a workplace that never chose takes its appointments: confirmed at once, or after
   * the center approves. TODO(decision): the default (doc 09, open item 1: manual).
   */
  'booking.default_approval_mode': define({
    schema: z.enum(['auto', 'manual']),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** How many days ahead a patient may book. TODO(decision): the value; 60 until then. */
  'booking.booking_horizon_days': define({
    schema: z.number().int().min(1).max(365),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  // booking (task 2-6, doc 08 §7; doc 09 open items 2, 3 and 9)
  /** How long a chosen slot is held for the patient. TODO(decision): 10 until then. */
  'booking.hold_minutes': define({
    schema: z.number().int().min(1).max(60),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Reminders before a confirmed appointment. TODO(decision): 24 h and 2 h until then. */
  'booking.reminder_offsets_minutes': define({
    schema: z
      .array(z.number().int().min(5).max(10_080))
      .max(5)
      .refine((v) => new Set(v).size === v.length, { message: 'repeated offset' }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** A patient may cancel until this long before. TODO(decision): 2 h until then. */
  'booking.patient_cancel_cutoff_minutes': define({
    schema: z.number().int().min(0).max(10_080),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * How long a center has to answer a request (doc 08 §7: 15 working minutes).
   * TODO(decision): counted on the wall clock for now, not in working minutes.
   */
  'booking.center_approval_sla_minutes': define({
    schema: z.number().int().min(1).max(1440),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The texts of the appointment SMS, edited from the panel (doc 08 §7). Placeholders:
   * {doctor}, {place}, {date} (Jalali), {time} (Tehran) and, when confirmed, {code}.
   */
  'booking.sms_templates': define({
    schema: z.object({
      confirmed: smsText,
      reminder: smsText,
      cancelledByCenter: smsText,
      approvalOverdue: smsText,
    }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  // catalog: the public search of doctors and centers (task 2-7, doc 08 §9)
  /** Feature flag of the public search (CLAUDE.md §4): off until the owner turns it on. */
  'catalog.search_enabled': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * Feature flag of the «پیشنهاد سپهر» section (task 2-7 decision 3): a separate, labelled
   * list, never mixed into the results. Empty even when on: TODO(decision) what fills it.
   */
  'catalog.search_featured_enabled': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The public search: requests per client IP per minute; live slots shown per result; and
   * how long an index entry may go unrefreshed when nothing announced a change (a new day
   * entering the booking horizon, a changed weekly day off).
   */
  'catalog.search_policy': define({
    schema: z.object({
      perIpPerMinute: count,
      slotsPerResult: z.number().int().min(0).max(10),
      maxEntryAgeMinutes: z.number().int().min(5).max(1440),
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  // catalog: the doctor's public profile and its media (task 2-8, doc 08 §10)
  /**
   * Uploads of profile media: size limits, the longest video, the widths of the image
   * variants, and how long a signed link to a private file lives. The scanner must accept a
   * file this large (clamd StreamMaxLength; docs/09 deployment notes).
   */
  'catalog.profile_media_policy': define({
    schema: z.object({
      imageMaxBytes: z
        .number()
        .int()
        .min(100_000)
        .max(20 * 1024 * 1024),
      videoMaxBytes: z
        .number()
        .int()
        .min(1_000_000)
        .max(100 * 1024 * 1024),
      videoMaxSeconds: z.number().int().min(10).max(1800),
      imageWidths: z.array(z.number().int().min(64).max(4096)).min(1).max(6),
      signedUrlSeconds: z.number().int().min(30).max(3600),
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * Where profile videos live (doc 08 §10): `aparat` (only the video id is kept) or `self`
   * (HLS made by ffmpeg in the worker). TODO(decision): aparat until then (no ffmpeg needed).
   */
  'catalog.profile_video_hosting': define({
    schema: z.enum(['aparat', 'self']),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Show «patients referred» on the public profile. TODO(decision): off (doc 09 item 6). */
  'catalog.profile_show_referral_count': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Feature flag of the bulk import of centers and doctors (task 2-9): off until turned on. */
  /**
   * Owner 1405/07/29, answer i: when on, a visit's price is set only from the internal panel
   * by two people (catalog.manage_visit_tariffs); the center panel's own path refuses the
   * visit. Off by default (a feature flag), so nothing changes until two people turn it on.
   */
  'catalog.visit_tariff_internal_only': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  'catalog.bulk_import_enabled': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  // business rules with defaults stated in the docs
  /** Installments are rounded down to this unit (doc 02 §5). */
  'repayment.rounding_unit_rial': define({
    schema: rial,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Cancellation penalty after funding (doc 02 §6); a case may override it with a reason.
   * 0 to 18% (owner پ۱۳, 1405/07/14): higher only with a new ADR.
   */
  'repayment.cancellation_penalty_bps': define({
    schema: z.number().int().min(0).max(1_800),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  // settlement (task 5-1; doc 06 §3; CLAUDE.md §4: 0 at first, two people, locked per record)
  /** The fee of a credit service: a percent (bps) or a fixed amount, per level. */
  'settlement.credit_service_fee': define({
    schema: serviceFeeRateSchema,
    levels: ['global', 'treatment_field', 'center', 'doctor'],
    category: 'business',
    sensitive: true,
  }),
  /** The fee of a cash service (task 5-3): its own rate, with the same levels. */
  'settlement.cash_service_fee': define({
    schema: serviceFeeRateSchema,
    levels: ['global', 'treatment_field', 'center', 'doctor'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * ADR-046 (owner 1405/07/27): a doctor's or center's contract term, 3, 6 or 12 months; from
   * its end, no new service. The most specific level wins, as for the fee. Global: none.
   */
  'settlement.provider_contract': define({
    schema: providerContractSchema,
    levels: ['global', 'center', 'doctor'],
    category: 'business',
    sensitive: true,
  }),
  /** ADR-046: how many days before a term ends its notice opens (owner: 30). */
  'settlement.provider_contract_warn_days': define({
    schema: z.number().int().min(0).max(365),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Months from a service's final day to its payable's due day (owner: monthly, 1). */
  'settlement.contract_cycle_months': define({
    schema: z.number().int().min(1).max(36),
    levels: ['global', 'treatment_field', 'doctor'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Days after its due day an unpaid installment is still due, not overdue (task 6-1;
   * doc 15 §3; 6.2: 0). Locked on each schedule when it is made (rule 16).
   */
  'repayment.grace_days': define({
    schema: z.number().int().min(0).max(90),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Days before its due day an installment's reminder is sent, 0 the due day itself (task
   * 6-6; doc 15 §4; 6.3: 3 and 0). Empty: no reminders. Read on each nightly run.
   */
  'repayment.reminder_days_before': define({
    schema: z.array(z.number().int().min(0).max(30)).max(10),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Days past its due day an overdue installment's notice is sent (task 6-6; doc 15 §4;
   * 6.3: 1, 7 and 15). Empty: no notices. Read on each nightly run.
   */
  'repayment.overdue_notice_days': define({
    schema: z.array(z.number().int().min(1).max(365)).max(10),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** The overdue queue's buckets, by their first day past due (task 6-7; 6.4: 1/31/61/91). */
  'collection.buckets': define({
    schema: collectionBucketsSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Escalation stages 1 to 3 by days or overdue installments (task 6-7; doc 15 §5; 6.4). */
  'collection.escalation_rules': define({
    schema: escalationRulesSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** A case back in the queue goes to its last collection agent (task 6-7; default off). */
  'collection.same_agent_for_returning': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * A cheque's execution may be proposed once its loan is this many days or more past due
   * (task 6-8; CLAUDE.md §4: 0 at first, any overdue loan). Locked on nothing: read when proposed.
   */
  'instrument.execution_min_days_past_due': define({
    schema: z.number().int().min(0).max(3650),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Ticket topics (task 7-1; doc 17 §1; 7.5): each to a unit and a response deadline, locked
   * on the ticket when opened. Deadlines 0 at first (CLAUDE.md §4: none until set).
   */
  'ticket.topics': define({
    schema: ticketTopicsSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Days after resolved a requester may reopen (7.4: 7; CLAUDE.md §4: 0, reopening off). */
  'ticket.reopen_days': define({
    schema: z.number().int().min(0).max(365),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Minutes before the deadline its warning goes out (task 7-1; 0: only once it passed). */
  'ticket.sla_warning_minutes': define({
    schema: z.number().int().min(0).max(10_080),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Above this many rows an export is made in the background (task 7-3; 7.3: 5,000). */
  'reporting.async_export_rows': define({
    schema: z.number().int().min(1).max(10_000_000),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** Tehran hours non-urgent SMS may be sent in (task 6-4; doc 15 §7; 6.5: 8 to 21). */
  'notification.allowed_hours': define({
    schema: allowedHoursSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Bulk SMS (task 6-5; 6.6; owner): above this many recipients, only a holder of
   * notification.approve_campaigns approves; at or below it, any second person with
   * manage_campaigns. Never the creator. Locked on each campaign when it is made.
   */
  'notification.bulk_two_person_threshold': define({
    schema: z.number().int().min(0),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Bulk SMS sent per minute (task 6-5; 6.8: the provider's real cap is the client's). */
  'notification.campaign_batch_per_minute': define({
    schema: z.number().int().min(0).max(100_000),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** Feature flag of promotional campaigns (owner): off until unsubscribing is built. */
  'notification.promotional_campaigns_enabled': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** The estimated price of one SMS part, rials (task 6-4; CLAUDE.md §4: 0 at first). */
  'notification.segment_cost_rial': define({
    schema: z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * ADR-052: warn when the Kavenegar account's credit falls below this many rials ("0" = off).
   */
  'notification.sms_credit_alert_rial': define({
    schema: z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** The Jalali day of the month the doctors are paid (owner: 10). */
  'settlement.payout_day': define({
    schema: z.number().int().min(1).max(29),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Periods a doctor's negative balance runs before accounting is alerted (owner: 2). */
  'settlement.negative_balance_alert_periods': define({
    schema: z.number().int().min(1).max(24),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Days from a cancellation after funding to its penalty's due day (owner پ۱۲-ب: 30). */
  'repayment.cancellation_penalty_due_days': define({
    schema: z.number().int().min(1).max(365),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Whether a due date on a holiday moves to the next working day (doc 02 §5).
   * TODO(decision): the client's confirmation; off until then.
   */
  /**
   * The credit scoring rules (doc 03; task 3-2): criteria, options and scores, grades,
   * amount levels, the guarantee matrix and who decides. Version 1 is the client's
   * workbook. A new version is activated only by a second person, and only if every
   * golden case of the workbook still holds (the credit module checks both proposal and
   * approval). A credit application keeps the version it was scored with (rule 16).
   */
  'credit.scoring_ruleset': define({
    schema: scoringRulesetSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The credit plans (doc 10 §3; task 3-3): who they are for, amounts, down payment,
   * installment counts, plan fee (spread or at completion) and origination fee. Defined
   * by the strategy manager and approved by a second person; a case keeps the version it
   * chose (rule 16). TODO(decision): the pilot's plans; none until the client gives them.
   */
  'credit.plans': define({
    schema: creditPlansSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** The patient may ask for a smaller loan and pay the rest in cash (doc 10 §3). Off. */
  'credit.allow_patient_amount_reduction': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** How long an issued proforma stands before it expires (doc 10 §2 rule 5); 30 days. */
  /** Hours from «ready for review» to a credit decision before the queue manager is told (doc 10 §4). */
  /**
   * The text a borrower or guarantor consents to before their data is checked (doc 03
   * §8-6). Versioned: each consent keeps the version it was given to. TODO(decision): the
   * legal text, from the company's counsel; a placeholder until then.
   */
  /**
   * The documents asked of a borrower and of each guarantor (doc 10 §4), by role and, when
   * known, job. TODO(decision): the client's real list; a starting list until then.
   */
  'credit.document_checklist': define({
    schema: creditDocumentChecklistSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** The size of a credit document and how long its signed link lives. */
  'credit.document_policy': define({
    schema: creditDocumentPolicySchema,
    levels: ['global'],
    category: 'technical',
    // Every key is sensitive for now (task 0-6 decision).
    sensitive: true,
  }),
  /** A rejected document's SMS to its owner; placeholder {document} (its title). */
  'credit.document_sms_templates': define({
    schema: z.object({
      documentRejected: z
        .string()
        .min(10)
        .max(400)
        .refine((t) => t.includes('{document}'), { message: 'needs {document}' }),
    }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The rejection reasons a decision picks from (doc 10 §6), edited from the panel.
   * TODO(decision): the client's list; a starting list until then.
   */
  'credit.rejection_reasons': define({
    schema: creditRejectionReasonsSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The risk and credit committee (doc 03 §6): its units, the roles that make someone a
   * member of each, and how many units must approve. TODO(decision): two of three.
   */
  'credit.committee_units': define({
    schema: creditCommitteeUnitsSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** The patient's SMS on a decision; never a reason or a score (doc 10 §6). */
  'credit.decision_sms_templates': define({
    schema: creditDecisionSmsTemplatesSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * A shortfall the patient pays in cash at the doctor, outside the ledger, up to this
   * share of the approved amount (doc 10 §7); beyond it, a new case and loan. 10%.
   * TODO(decision): the client's threshold.
   */
  /**
   * The formation deposit (owner 1405/07/29, answer f): whole rials, "0" = off (the default).
   * Locked on each recorded deposit with its version. The client's number is in
   * docs/pending-client-decisions.md. No ledger row in the pilot.
   */
  'credit.formation_deposit_rial': define({
    schema: z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * ADR-051 (ج۶; owner 1405/07/30, answer 8): the cap on a borrower's whole active balance,
   * checked under a lock on the borrower's row when a loan is approved and when it is funded.
   * capRial "0" = off (the annex: 1,500,000,000). basis: `obligation`, what is still owed on the
   * schedules (the default); `loan`, the approved amounts of the open purses, payments not
   * deducted. includeApprovedUnfunded: also the approved loans not yet funded (the default).
   */
  'credit.borrower_exposure_cap': define({
    schema: z.strictObject({
      capRial: z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
      basis: z.enum(['obligation', 'loan']),
      includeApprovedUnfunded: z.boolean(),
    }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  'credit.small_shortfall_bps': define({
    schema: z.number().int().min(0).max(10_000),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The loan contract's template (doc 12 §2; task 4-1): versioned, published only by a
   * second person and only with the cancellation penalty in its text (the contract module
   * guards it). TODO(decision): the legal text, from counsel; a sample until then.
   */
  'contract.loan_template': define({
    schema: contractTemplateSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Owner 1405/07/27 (plan e): promissory notes are not taken. Off: no delivery item and no
   * instrument of that kind (409 promissory_disabled); the panel hides its field. Those
   * recorded before stay, and their legal referral (stage 4) is unchanged.
   */
  'instrument.promissory_enabled': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The cheque rule (owner 1405/07/29, ج۵; the October 1405 annex): a case is not completed
   * until the borrower has given at least this many cheques (their installment cheques), each
   * checked. 0 = off (the default); the annex's number, 1, is set by two people at launch.
   */
  'instrument.borrower_cheque_min_count': define({
    schema: z.number().int().min(0).max(100),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * The cheque rule (owner 1405/07/29, ج۵): each guarantor's checked cheques (their guarantee
   * cheques) together reach at least this share of the proforma's total, in basis points
   * (11000 = 110%), rounded up to the rial. 0 = off (the default); the annex's number, 11000,
   * is set by two people at launch.
   */
  'instrument.guarantee_cheque_min_bps': define({
    schema: z.number().int().min(0).max(100_000),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** A delivery's shortage SMS to the case's owner (doc 12 §3): item names only. */
  'instrument.sms_templates': define({
    schema: instrumentSmsTemplatesSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Funding's SMS (doc 12 §5; task 4-5): the patient's ({amount}, {count}, {firstAmount},
   * {firstDue}) and the doctor's, which names no amount and nothing of the patient's finances.
   */
  'wallet.sms_templates': define({
    schema: walletSmsTemplatesSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  // service: authorizations and their codes (doc 12 §6; task 4-6; doc 13 open item 6)
  /** How long a service code is valid. */
  'service.code_ttl_minutes': define({
    schema: z.number().int().min(1).max(60),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** An authorization not confirmed by then is cancelled and its reservation freed. */
  'service.authorization_ttl_hours': define({
    schema: z.number().int().min(1).max(168),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Hours from delivery to final (doc 13 open item 5: the dispute window; 0 = at once). */
  'service.finalize_after_hours': define({
    schema: z.number().int().min(0).max(720),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Wrong codes an authorization takes before it expires (doc 12 §6.4). */
  'service.max_code_attempts': define({
    schema: z.number().int().min(1).max(10),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Codes sent per authorization, the first included (owner, پ۵: 3). */
  'service.max_code_sends': define({
    schema: z.number().int().min(1).max(10),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Seconds between two codes of one authorization (owner, پ۵: 60). */
  'service.code_resend_cooldown_seconds': define({
    schema: z.number().int().min(10).max(3600),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** The service code's SMS: code, amount and center; never the treatment. */
  'service.sms_templates': define({
    schema: serviceSmsTemplatesSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** The purse's name on the patient's pages (task 4-7): «کیف اعتبار», never the money-wallet phrase (doc 01). */
  'wallet.purse_title': define({
    schema: purseTitleSchema,
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  // credit transfer to an AuthorizedRecipient (task 4-8; owner 1405/07/14, س۳ to س۹)
  /** Feature flag: off until the recipient's mobile and national ID are matched (owner س۳). */
  'wallet.credit_transfer_enabled': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** Hours from both codes checked to approval (owner س۶: 24). */
  'wallet.credit_transfer_code_valid_hours': define({
    schema: z.number().int().min(1).max(168),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** What a recipient may use at most, and how many transfers a purse may have (owner). */
  'wallet.credit_transfer_limits': define({
    schema: z.object({
      /** ADR-047: null, no cap but what the purse holds (owner 1405/07/27). */
      maxAmountRial: z
        .string()
        .regex(/^(0|[1-9][0-9]{0,17})$/)
        .nullable(),
      maxPerPurse: z.number().int().min(0).max(20),
    }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** The borrower's SMS once their recipient's service is recorded: no code, no amount (س۸). */
  'wallet.credit_transfer_sms_templates': define({
    schema: z.object({ serviceRecorded: z.string().min(10).max(300) }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  'credit.consent_text': define({
    schema: z.object({ text: z.string().min(20).max(5000) }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Credit SMS texts. A guarantor's invitation says no more than the commitment (doc 10
   * §5): never the treatment, the doctor or a score. Placeholder: {amount} (tomans).
   */
  'credit.sms_templates': define({
    schema: z.object({
      guarantorInvited: z
        .string()
        .min(10)
        .max(400)
        .refine((t) => t.includes('{amount}'), { message: 'needs {amount}' }),
    }),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  'credit.sla_hours': define({
    schema: z.number().int().min(1).max(720),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Count the deadline in working hours only (doc 10 §4). Off; working hours are not
   * defined yet, so turning it on changes nothing until they are (TODO(decision)).
   */
  'credit.sla_business_hours_only': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /** Days an application may stay draft or incomplete before it expires (doc 10 §4). */
  'credit.incomplete_expiry_days': define({
    schema: z.number().int().min(1).max(365),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  'proforma.validity_days': define({
    schema: z.number().int().min(1).max(365),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  'repayment.shift_due_to_next_working_day': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * A returning person goes back to their previous advisor when that advisor can take
   * them (doc 05 §6: may be turned off).
   */
  'lead.returning_to_previous_agent': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  /**
   * Feature flag of the Excel import of patients and leads (task 2-5b decision 2): off
   * until task 2-8 scans uploads with ClamAV. TODO(2-8).
   */
  'lead.excel_import_enabled': define({
    schema: z.boolean(),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /**
   * The signed WordPress webhook (doc 05 §7, task 2-5b decision 5): how old a signed
   * request may be, and how many per source and per mobile.
   */
  'lead.webhook_policy': define({
    schema: z.object({
      maxAgeSeconds: z.number().int().min(30).max(3600),
      perSourcePerMinute: count,
      perMobilePerHour: count,
    }),
    levels: ['global'],
    category: 'technical',
    sensitive: true,
  }),
  /** A lead for the same person within this many days is a duplicate (doc 05). */
  /**
   * Task 9-3 (owner, 1405/07/19): days a mobile added to an existing Person stays pending
   * before it is refused by itself. Locked on the row when it is added.
   */
  'lead.person_mobile_pending_days': define({
    schema: z.number().int().min(1).max(365),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
  'lead.duplicate_window_days': define({
    schema: z.number().int().min(1).max(365),
    levels: ['global'],
    category: 'business',
    sensitive: true,
  }),
} as const;

export type ConfigKey = keyof typeof CONFIG_KEYS;
export type ConfigValue<K extends ConfigKey> = z.output<(typeof CONFIG_KEYS)[K]['schema']>;

export const CONFIG_KEY_NAMES = Object.keys(CONFIG_KEYS) as ConfigKey[];

export function isConfigKey(value: string): value is ConfigKey {
  return Object.hasOwn(CONFIG_KEYS, value);
}

/** A city or treatment-field code; center and doctor levels take an org node id. */
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);

export const configScopeRefSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('global') }),
  z.object({ level: z.literal('city'), ref: codeSchema }),
  z.object({ level: z.literal('treatment_field'), ref: codeSchema }),
  z.object({ level: z.literal('center'), ref: z.uuid() }),
  z.object({ level: z.literal('doctor'), ref: z.uuid() }),
]);
export type ConfigScopeRef = z.infer<typeof configScopeRefSchema>;

/** What a record is about, for resolve(): every part optional. */
export const configScopeSchema = z.object({
  cityCode: codeSchema.optional(),
  treatmentFieldCode: codeSchema.optional(),
  centerNodeId: z.uuid().optional(),
  doctorNodeId: z.uuid().optional(),
});
export type ConfigScope = z.infer<typeof configScopeSchema>;

const reasonSchema = z.string().transform(normalizePersianText).pipe(z.string().min(3).max(500));

export const proposeConfigSchema = z.object({
  key: z.string().refine(isConfigKey, { message: 'unknown configuration key' }),
  scope: configScopeRefSchema,
  /** null withdraws this level's value: the level above applies again. */
  value: z.unknown(),
  /** Omitted: the value applies from its approval. Never in the past. */
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
  reason: reasonSchema,
});
export type ProposeConfig = z.input<typeof proposeConfigSchema>;

export const resolveConfigQuerySchema = configScopeSchema.extend({
  key: z.string().refine(isConfigKey, { message: 'unknown configuration key' }),
  at: z.iso.datetime({ offset: true }).optional(),
});

/** One version of a configuration value, as the API shows it (task 3-8: typed client). */
export const configVersionViewSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  scopeLevel: z.enum(CONFIG_LEVELS),
  scopeRef: z.string().nullable(),
  value: z.unknown(),
  effectiveAt: z.string().nullable(),
  status: z.enum(['proposed', 'approved', 'rejected', 'expired']),
  reason: z.string(),
  proposedBy: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ConfigVersionViewBody = z.infer<typeof configVersionViewSchema>;

/** `GET /config/keys`: every key, its category, and the levels it may be set at. */
export const configKeyListSchema = z.array(
  z.object({
    key: z.string(),
    category: z.enum(['business', 'technical']),
    sensitive: z.boolean(),
    levels: z.array(z.enum(CONFIG_LEVELS)),
  }),
);

/** `GET /config/resolve`: the value in force for a scope, and the version to lock to. */
export const resolvedConfigViewSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  versionId: z.uuid(),
  level: z.enum(CONFIG_LEVELS),
  effectiveFrom: z.iso.datetime({ offset: true }),
});
