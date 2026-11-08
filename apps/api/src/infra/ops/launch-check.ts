import { FINANCIAL_SIGNING_PERMISSIONS } from '@sepehr/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ACCESS_PORT, type AccessPort } from '../../common/auth/access.port';
import { CENTER_DIRECTORY, type CenterDirectory } from '../../common/catalog/center-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { MIGRATIONS_FOLDER } from '../../db/migrate';
import { FieldReencryptionRegistry } from '../../security/field-reencryption';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface LaunchCheck {
  /** The launch checklist item of docs/ops/RESUME.md it checks. */
  readonly item: number;
  readonly code: string;
  readonly status: CheckStatus;
  /** Counts and names only, never personal data (rule 30). */
  readonly detail: string;
}

const IDENTITY_FLAGS = [
  'identity.reauth',
  'identity.factor_change_sms',
  'identity.staff_mobile_required',
] as const;

const CHEQUE_RULE_KEYS = [
  'instrument.borrower_cheque_min_count',
  'instrument.guarantee_cheque_min_bps',
] as const;

/**
 * Item 16: how far the application's clock and the database's may differ. A technical bound,
 * not a business number: with NTP on both servers they agree within milliseconds; a second
 * means one of them does not keep time (due days, expiries and «now» in SQL would disagree).
 */
export const MAX_CLOCK_SKEW_MS = 1_000;

/** A text not yet approved by counsel says so: the old sample label or the draft one. */
const DRAFT_MARKS = ['غیرقابل استفاده', 'پیش‌نویس — در انتظار تأیید حقوقی'] as const;

/**
 * The launch checklist of docs/ops/RESUME.md, as far as the database can tell (owner
 * 1405/07/23): read only, nothing is changed. Run against production before launch, connected
 * as the application role (`pnpm ops:launch-check`); any `fail` blocks the launch, a `warn`
 * asks a person to look. Items the database cannot see (Grafana's alert rule, the prettier
 * rule, the case state machine rule) stay on the checklist.
 */
@Injectable()
export class LaunchChecks {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(ACCESS_PORT) private readonly access: AccessPort,
    private readonly reencryption: FieldReencryptionRegistry,
    @Inject(CENTER_DIRECTORY) private readonly centers: CenterDirectory,
  ) {}

  /**
   * `migrationsDb`: a connection as the migration role (MIGRATION_DATABASE_URL), which reads
   * the applied list the application role may not; without it, the application role tries.
   */
  async run(now = new Date(), migrationsDb?: Database): Promise<LaunchCheck[]> {
    return [
      await this.appRole(this.db),
      ...(await this.identityFlags(now)),
      await this.blindIndexKeys(),
      await this.mobileApprovers(),
      await this.patientMobileChangers(now),
      await this.legalTexts(now),
      await this.holidayHolders(),
      await this.contractTerms(now),
      await this.staffOffboarders(),
      await this.failedQueueThreshold(now),
      await this.clockSkew(),
      ...(await this.chequeRule(now)),
      await this.costSplitReviewers(),
      await this.borrowerCap(now),
      smsProviderCheck(process.env),
      stepUpTemplateCheck(process.env),
      await this.signerMobiles(),
      await this.smsCreditAlert(now),
      await this.financialStepUp(now),
      await this.mobileChangeApprovers(),
      await this.technicalConfigApprovers(),
      ...ownerAcceptedItems(),
      await this.migrations(migrationsDb),
    ];
  }

  /**
   * Item 27 (ADR-052): every holder of a financial signing permission proves their own mobile
   * once; the code of each signature goes there. A warning (counts only, no names): a signer
   * without one simply cannot sign until they prove it.
   */
  async signerMobiles(): Promise<LaunchCheck> {
    const signers = new Set<string>();
    for (const code of FINANCIAL_SIGNING_PERMISSIONS) {
      for (const id of await this.access.holdersOfPermission(code)) signers.add(id);
    }
    const ids = [...signers];
    const { rows } = ids.length
      ? await this.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM user_accounts
          WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})
            AND (mobile IS NULL OR mobile_verified_at IS NULL)`)
      : { rows: [{ n: 0 }] };
    const missing = rows[0]?.n ?? 0;
    return {
      item: 27,
      code: 'signer_mobiles',
      status: missing === 0 && ids.length > 0 ? 'pass' : 'warn',
      detail: `${String(ids.length)} financial signers, ${String(missing)} without a verified mobile of their own`,
    };
  }

  /** Item 28 (ADR-052): the SMS credit alert; "0" is off, and an empty account stops every signature. */
  async smsCreditAlert(now: Date): Promise<LaunchCheck> {
    let value: string;
    try {
      ({ value } = await this.config.resolve('notification.sms_credit_alert_rial', {}, now));
    } catch {
      return {
        item: 28,
        code: 'notification.sms_credit_alert_rial',
        status: 'warn',
        detail: 'not configured yet (migration 0106 not applied)',
      };
    }
    return {
      item: 28,
      code: 'notification.sms_credit_alert_rial',
      status: value === '0' ? 'warn' : 'pass',
      detail:
        value === '0' ? 'off: nobody is told before the SMS credit runs out' : `${value} rials`,
    };
  }

  /**
   * Item 29 (owner 1405/08/03): the SMS code of financial signatures ships off. Turned on by two
   * people once the second Kavenegar template works in production, a test SMS has arrived and
   * every signer has a verified mobile; until then a warning, and approvals need no code.
   */
  async financialStepUp(now: Date): Promise<LaunchCheck> {
    try {
      const { value } = await this.config.resolve('identity.financial_step_up', {}, now);
      return {
        item: 29,
        code: 'identity.financial_step_up',
        status: value.enabled ? 'pass' : 'warn',
        detail: value.enabled
          ? 'on: every financial signature asks for its SMS code'
          : 'off: financial approvals need no code; turn on by two people after the production template, a test SMS and every signer with a verified mobile',
      };
    } catch {
      return {
        item: 29,
        code: 'identity.financial_step_up',
        status: 'warn',
        detail: 'not configured yet (migration 0106 not applied)',
      };
    }
  }

  /**
   * Item 30 (owner 1405/08/03): a signer's mobile change needs two approvers other than its
   * owner, so the mobile of the CEO or the system administrator needs a third approver
   * (`mobile_change_approver`, held by the owner / IT officer). Warns below three distinct
   * holders, and when the third approver also holds the CEO's or the system administrator's role
   * or any financial signing permission (three distinct people, none of them a financial signer).
   */
  async mobileChangeApprovers(): Promise<LaunchCheck> {
    const holders = new Set(
      await this.access.holdersOfPermission('identity.approve_financial_mobile_change'),
    );
    const leaders = new Set([
      ...(await this.access.holdersOf('ceo')),
      ...(await this.access.holdersOf('system_admin')),
    ]);
    const third = await this.access.holdersOf('mobile_change_approver');
    let mixed = 0;
    for (const id of third) {
      const { permissions } = await this.access.resolve(id);
      const signs = FINANCIAL_SIGNING_PERMISSIONS.some(
        (p) => p !== 'identity.approve_financial_mobile_change' && permissions.has(p),
      );
      if (leaders.has(id) || signs) mixed += 1;
    }
    const warn = holders.size < 3 || third.length === 0 || mixed > 0;
    return {
      item: 30,
      code: 'identity.approve_financial_mobile_change',
      status: warn ? 'warn' : 'pass',
      detail:
        mixed > 0
          ? `سه نفر متمایز لازم است: the third approver also holds the CEO's or the system administrator's role, or a financial signing permission (${String(holders.size)} holders)`
          : `${String(holders.size)} distinct holders (3 needed), ${String(third.length)} third approver${third.length === 0 ? ' (pending: the owner / IT officer)' : ''}`,
    };
  }

  /**
   * Item 31 (owner 1405/08/03, 0107): a technical setting is proposed by the system
   * administrator and decided by another role (`technical_config_approver`, assigned by the
   * owner). Warns while nobody holds that role, or when its holder is a system administrator too.
   * The old `config.manage_technical` still lets two administrators decide until the owner
   * approves taking it away; the detail says so.
   */
  async technicalConfigApprovers(): Promise<LaunchCheck> {
    const approvers = await this.access.holdersOf('technical_config_approver');
    const admins = new Set(await this.access.holdersOf('system_admin'));
    const both = approvers.filter((id) => admins.has(id)).length;
    const oldStill = (await this.access.holdersOfPermission('config.manage_technical')).length;
    return {
      item: 31,
      code: 'config.approve_technical',
      status: approvers.length === 0 || both > 0 ? 'warn' : 'pass',
      detail: `${String(approvers.length)} technical-settings approvers, ${String(both)} also system administrators; config.manage_technical still held by ${String(oldStill)}`,
    };
  }

  /**
   * Item 16 (owner 1405/07/29): the application server keeps the database server's time (NTP on
   * both). The database's clock, read once, must fall within the call's round trip on this
   * host's clock, give or take {@link MAX_CLOCK_SKEW_MS}; else a block.
   */
  async clockSkew(hostNow: () => number = Date.now): Promise<LaunchCheck> {
    const before = hostNow();
    const { rows } = await this.db.execute<{ ms: string }>(
      sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms`,
    );
    const after = hostNow();
    const database = Number(rows[0]?.ms);
    const ahead = database > after ? database - after : 0;
    const behind = database < before ? before - database : 0;
    const skew = Math.max(ahead, behind);
    return {
      item: 16,
      code: 'clock_skew',
      status: Number.isFinite(database) && skew <= MAX_CLOCK_SKEW_MS ? 'pass' : 'fail',
      detail: `database clock ${ahead > 0 ? 'ahead' : behind > 0 ? 'behind' : 'in step'} by ${String(skew)} ms (at most ${String(MAX_CLOCK_SKEW_MS)}; NTP on both servers)`,
    };
  }

  /**
   * Item 17 (owner, ج۵): the cheque rule's two numbers, set by two people to the October 1405
   * annex's (1 cheque of the borrower; each guarantor's at 11000 bps = 110% of the proforma).
   * Either still 0 (off) warns, never blocks.
   */
  async chequeRule(now: Date): Promise<LaunchCheck[]> {
    const checks: LaunchCheck[] = [];
    for (const key of CHEQUE_RULE_KEYS) {
      const { value } = await this.config.resolve(key, {}, now);
      checks.push({
        item: 17,
        code: key,
        status: value > 0 ? 'pass' : 'warn',
        detail: value > 0 ? String(value) : '0 (off; the annex: borrower 1, guarantee 11000 bps)',
      });
    }
    return checks;
  }

  /**
   * Item 19 (owner 1405/08/01, ADR-050 amendment): a wage-only case's split is checked by someone
   * other than its issuer, so at least two holders of credit.review_cost_split (credit_specialist
   * or case_completion); fewer warns, never blocks (the plan may not be offered at launch).
   */
  async costSplitReviewers(): Promise<LaunchCheck> {
    const n = new Set(await this.access.holdersOfPermission('credit.review_cost_split')).size;
    return {
      item: 19,
      code: 'credit.review_cost_split',
      status: n >= 2 ? 'pass' : 'warn',
      detail: `${String(n)} holders (at least 2: credit_specialist or case_completion)`,
    };
  }

  /**
   * Item 20 (ADR-051): the cap on a borrower's whole active balance, set by two people to the
   * annex's 1,500,000,000 rials. Still "0" (off) warns, never blocks.
   */
  async borrowerCap(now: Date): Promise<LaunchCheck> {
    const { value } = await this.config.resolve('credit.borrower_exposure_cap', {}, now);
    const on = BigInt(value.capRial) > 0n;
    return {
      item: 20,
      code: 'credit.borrower_exposure_cap',
      status: on ? 'pass' : 'warn',
      detail: on
        ? `${value.capRial} (${value.basis})`
        : '0 (off; the annex: 1500000000 on what is still owed)',
    };
  }

  /** Item 1: the connection is not a superuser, does not bypass RLS, owns no table. */
  async appRole(db: Database): Promise<LaunchCheck> {
    const { rows } = await db.execute<{
      role: string;
      superuser: boolean;
      bypassrls: boolean;
      owned: number;
    }>(sql`
      SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND pg_get_userbyid(c.relowner) = current_user) AS owned
      FROM pg_roles r WHERE r.rolname = current_user
    `);
    const r = rows[0];
    const bad = !r || r.superuser || r.bypassrls || r.owned > 0;
    return {
      item: 1,
      code: 'app_role',
      status: bad ? 'fail' : 'pass',
      detail: r
        ? `${r.role}: superuser ${String(r.superuser)}, bypassrls ${String(r.bypassrls)}, owns ${String(r.owned)} tables`
        : 'no role row',
    };
  }

  /** Item 2: the three identity flags are on. */
  async identityFlags(now: Date): Promise<LaunchCheck[]> {
    const checks: LaunchCheck[] = [];
    for (const key of IDENTITY_FLAGS) {
      const { value } = await this.config.resolve(key, {}, now);
      checks.push({
        item: 2,
        code: key,
        status: value.enabled ? 'pass' : 'fail',
        detail: value.enabled ? 'on' : 'off',
      });
    }
    return checks;
  }

  /**
   * Item 4: every blind-index column under one key. Then no two live rows can hold one
   * value under two keys; with two keys, the full duplicate query of
   * blind-index-multikey-plan.md §4 is run, with the keys, before key 2 is switched on.
   */
  async blindIndexKeys(): Promise<LaunchCheck> {
    // Every blind-index column a module registered for re-encryption, each read by its own
    // module (CLAUDE.md §5): a new one is checked without this list growing.
    const spread: string[] = [];
    for (const reencryptor of this.reencryption.all()) {
      for (const { column, prefixes } of (await reencryptor.blindIndexKeys?.()) ?? []) {
        if (prefixes.length > 1) {
          spread.push(`${column}: ${prefixes.map((r) => `${r.prefix} ${String(r.n)}`).join(', ')}`);
        }
      }
    }
    return {
      item: 4,
      code: 'blind_index_keys',
      status: spread.length === 0 ? 'pass' : 'warn',
      detail:
        spread.length === 0
          ? 'every column under one key'
          : `more than one key: ${spread.join('; ')}; run the cross-key duplicate query`,
    };
  }

  /** Item 5: two-person mobile approval needs at least two holders, better three. */
  async mobileApprovers(): Promise<LaunchCheck> {
    const n = (await this.access.holdersOfPermission('lead.approve_person_mobile')).length;
    return {
      item: 5,
      code: 'lead.approve_person_mobile',
      status: n >= 3 ? 'pass' : n === 2 ? 'warn' : 'fail',
      detail: `${String(n)} holders (at least 2, better 3)`,
    };
  }

  /**
   * Item 13 (owner 1405/07/26): identity.change_patient_mobile, a lost patient mobile changed
   * by two staff (f12 b2), in its own role for two or three named people, never an advisor or
   * support. Holders that are advisors or support fail; with the flag on, fewer than two fail;
   * with it off, the role is not needed yet and only warns.
   */
  async patientMobileChangers(now: Date): Promise<LaunchCheck> {
    const holders = await this.access.holdersOfPermission('identity.change_patient_mobile');
    const barred = new Set([
      ...(await this.access.holdersOf('advisor')),
      ...(await this.access.holdersOf('support')),
    ]);
    const mixed = holders.filter((a) => barred.has(a)).length;
    const { value } = await this.config.resolve('identity.patient_mobile_change', {}, now);
    const n = holders.length;
    const status: CheckStatus =
      mixed > 0 || (value.enabled && n < 2) ? 'fail' : n >= 2 && n <= 3 ? 'pass' : 'warn';
    return {
      item: 13,
      code: 'identity.change_patient_mobile',
      status,
      detail: `${String(n)} holders (2 to 3), ${String(mixed)} also advisor or support; flag ${value.enabled ? 'on' : 'off'}`,
    };
  }

  /**
   * Item 14 (owner 1405/07/27; 1405/08/02): the owner sets the counsel's texts after the launch
   * and before the first real contract. Until then a warning, not a block: the template still a
   * sample (printed «پیش‌نویس — در انتظار تأیید حقوقی») or the consent text a draft.
   */
  async legalTexts(now: Date): Promise<LaunchCheck> {
    const { value: template } = await this.config.resolve('contract.loan_template', {}, now);
    const { value: consent } = await this.config.resolve('credit.consent_text', {}, now);
    const draftConsent = DRAFT_MARKS.some((mark) => consent.text.includes(mark));
    const pending = [
      ...(template.sample ? ['contract.loan_template'] : []),
      ...(draftConsent ? ['credit.consent_text'] : []),
    ];
    return {
      item: 14,
      code: 'legal_texts',
      status: pending.length === 0 ? 'pass' : 'warn',
      detail:
        pending.length === 0
          ? 'contract template and consent text approved by counsel'
          : `before the first real contract (owner 1405/08/02): awaiting counsel: ${pending.join(', ')}`,
    };
  }

  /**
   * Item 10 (owner 1405/07/24, 1405/07/27): saving holidays takes two people, the general
   * manager and one other, so someone may ask and two different people may decide.
   */
  async holidayHolders(): Promise<LaunchCheck> {
    // Owner 1405/08/02: the CEO asks (config.manage_holidays); a second person decides, a
    // manage holder or the deputy who only approves (config.approve_holidays).
    const askers = await this.access.holdersOfPermission('config.manage_holidays');
    const deciders = new Set([
      ...askers,
      ...(await this.access.holdersOfPermission('config.approve_holidays')),
    ]);
    return {
      item: 10,
      code: 'config.manage_holidays',
      status: askers.length >= 1 && deciders.size >= 2 ? 'pass' : 'fail',
      detail: `${String(askers.length)} may ask, ${String(deciders.size)} may decide (at least 1 and 2: the general manager and one other)`,
    };
  }

  /**
   * Item 15 (owner 1405/07/27, ADR-046): every active center, and every workplace at one or in
   * a private practice, has an approved contract term of its own level (proposed with the
   * registration, approved by a second person). Any without: a block.
   */
  async contractTerms(now: Date): Promise<LaunchCheck> {
    const { centers, workplaces } = await this.centers.contractParties();
    let missingCenters = 0;
    for (const centerNodeId of centers) {
      const term = await this.config.resolve('settlement.provider_contract', { centerNodeId }, now);
      if (term.level !== 'center' || term.value.startsOn === null) missingCenters++;
    }
    let missingDoctors = 0;
    for (const w of workplaces) {
      const term = await this.config.resolve(
        'settlement.provider_contract',
        { doctorNodeId: w.nodeId, ...(w.centerNodeId ? { centerNodeId: w.centerNodeId } : {}) },
        now,
      );
      if (term.level !== 'doctor' || term.value.startsOn === null) missingDoctors++;
    }
    const missing = missingCenters + missingDoctors;
    return {
      item: 15,
      code: 'settlement.provider_contract',
      status: missing === 0 ? 'pass' : 'fail',
      detail: `${String(missingCenters)} of ${String(centers.length)} active centers and ${String(missingDoctors)} of ${String(workplaces.length)} workplaces without an approved contract term`,
    };
  }

  /**
   * Item 8: offboarding a staff member takes two people (owner 1405/07/23, plan 4): at least
   * one who may ask and one other who may approve. A warning, not a block: until then the
   * offboarding runbook revokes the roles one by one.
   */
  async staffOffboarders(): Promise<LaunchCheck> {
    const askers = await this.access.holdersOfPermission('identity.request_staff_offboarding');
    const approvers = await this.access.holdersOfPermission('identity.approve_staff_offboarding');
    // Two different people: an approver who is not the only asker.
    const enough = askers.length > 0 && approvers.some((a) => askers.some((b) => b !== a));
    return {
      item: 8,
      code: 'identity.staff_offboarding',
      status: enough ? 'pass' : 'warn',
      detail: `${String(askers.length)} may ask, ${String(approvers.length)} may approve (two different people needed)`,
    };
  }

  /** Item 6: failed jobs alert; the rule in Grafana stays on the checklist. */
  async failedQueueThreshold(now: Date): Promise<LaunchCheck> {
    const { value } = await this.config.resolve('ops.queue_alert_thresholds', {}, now);
    return {
      item: 6,
      code: 'ops.queue_alert_thresholds',
      status: 'warn',
      detail: `queue_failed above ${String(value.maxFailed)} failed jobs; route sepehr.alerts.active{code="queue_failed"} in Grafana to a named person`,
    };
  }

  /** Every migration of this build applied (item 5's 0085 among them). */
  async migrations(migrationsDb?: Database): Promise<LaunchCheck> {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const expected = journal.entries.length;
    try {
      const { rows } = await (migrationsDb ?? this.db).execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
      );
      const applied = rows[0]?.n ?? 0;
      return {
        item: 5,
        code: 'migrations',
        status: applied === expected ? 'pass' : 'fail',
        detail: `${String(applied)} applied of ${String(expected)}${migrationsDb ? ' (read as the migration role)' : ''}`,
      };
    } catch {
      return {
        item: 5,
        code: 'migrations',
        status: 'warn',
        detail: `${String(expected)} in this build; this role cannot read the applied list (set MIGRATION_DATABASE_URL)`,
      };
    }
  }
}

/**
 * Owner 1405/08/02: decisions the owner took knowingly, shown on every run so they are never
 * forgotten; warnings, never blocks, and never removed without the owner.
 * - 21: no penetration test before the pilot, a risk the owner accepted, with its compensations.
 * - 22: the scoring rules, set before the first real credit decision.
 * - 23: the lunar holidays of 1405 and 1406, saved by 1 Bahman 1405.
 * - 24: SMS codes instead of TOTP for financial approvals, a risk the owner accepted.
 */
export function ownerAcceptedItems(): LaunchCheck[] {
  return [
    {
      item: 21,
      code: 'pentest_risk_accepted',
      status: 'warn',
      detail:
        'risk accepted by the owner on 1405/08/02: no penetration test before the pilot; compensations: internal panel and SSH behind the VPN only, financial TOTP re-check before the first real customer, a limited pilot with a small cap, backups with a restore drill, monitoring',
    },
    {
      item: 22,
      code: 'scoring_rules',
      status: 'warn',
      detail:
        'before the first real credit decision (owner 1405/08/02): scoring rules v1 from Aramesh Sarvat',
    },
    {
      item: 24,
      code: 'financial_step_up_sms',
      status: 'warn',
      detail:
        'TOTP not used for financial approvals: SMS one-time codes (owner 1405/08/02), a risk accepted by the owner (SIM swap, dependence on SMS); compensations: VPN for the panel, rate limits, one unique mobile per approver, a small pilot cap; TOTP after the pilot',
    },
    {
      item: 23,
      code: 'lunar_holidays',
      status: 'warn',
      detail:
        'by 1 Bahman 1405 (owner 1405/08/02): the lunar holidays of 1405 and 1406, after their official announcement',
    },
  ];
}

/**
 * Item 25 (owner 1405/08/02): production never runs the printing SMS fake. The worker refuses
 * to start with it outside development or staging; this says so before launch too, read from
 * the environment this check runs with (the worker's own file on the server).
 */
export function smsProviderCheck(env: NodeJS.ProcessEnv): LaunchCheck {
  const provider = (env['SMS_PROVIDER'] ?? 'kavenegar').trim() || 'kavenegar';
  const staging = env['DEPLOY_ENV'] === 'staging';
  if (provider === 'fake') {
    return {
      item: 25,
      code: 'sms_provider',
      status: staging ? 'warn' : 'fail',
      detail: staging
        ? 'SMS_PROVIDER=fake on staging (no real SMS, as intended)'
        : 'SMS_PROVIDER=fake outside staging: no SMS would be sent (set kavenegar)',
    };
  }
  return {
    item: 25,
    code: 'sms_provider',
    status: provider === 'kavenegar' ? 'pass' : 'fail',
    detail: `SMS_PROVIDER=${provider}`,
  };
}

/**
 * Item 26 (ADR-052): with Kavenegar, the worker needs the second template for the financial
 * codes, its name read only from KAVENEGAR_STEP_UP_TEMPLATE (the name itself is in the
 * deployment guide, never in the code); without it no financial signature can be made.
 */
export function stepUpTemplateCheck(env: NodeJS.ProcessEnv): LaunchCheck {
  const provider = (env['SMS_PROVIDER'] ?? 'kavenegar').trim() || 'kavenegar';
  const template = env['KAVENEGAR_STEP_UP_TEMPLATE']?.trim() ?? '';
  if (provider !== 'kavenegar') {
    return {
      item: 26,
      code: 'step_up_template',
      status: 'warn',
      detail: `SMS_PROVIDER=${provider}`,
    };
  }
  return {
    item: 26,
    code: 'step_up_template',
    status: template ? 'pass' : 'fail',
    detail: template
      ? `KAVENEGAR_STEP_UP_TEMPLATE=${template}`
      : 'KAVENEGAR_STEP_UP_TEMPLATE is not set',
  };
}
