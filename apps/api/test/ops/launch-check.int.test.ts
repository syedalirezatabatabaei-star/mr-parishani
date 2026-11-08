import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import {
  CENTER_DIRECTORY,
  type CenterDirectory,
} from '../../src/common/catalog/center-directory.port';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import {
  LaunchChecks,
  smsProviderCheck,
  stepUpTemplateCheck,
  type LaunchCheck,
} from '../../src/infra/ops/launch-check';
import { FieldReencryptionRegistry } from '../../src/security/field-reencryption';
import { AccessService } from '../../src/modules/access/access.service';
import { grantRole, loggedInAccount, startHarness, type Harness } from '../identity/harness';

/**
 * The launch check (owner 1405/07/23): the RESUME launch checklist as far as the database can
 * tell, read only. Each check says pass or fail where it should, and nothing is written.
 */

type Row = Record<string, unknown>;

let h: Harness;
let checks: LaunchChecks;

beforeAll(async () => {
  h = await startHarness();
  checks = new LaunchChecks(
    h.app.get<Database>(DATABASE),
    h.app.get<ConfigPort>(CONFIG, { strict: false }),
    h.app.get<AccessPort>(ACCESS_PORT, { strict: false }),
    h.app.get(FieldReencryptionRegistry, { strict: false }),
    h.app.get<CenterDirectory>(CENTER_DIRECTORY, { strict: false }),
  );
});

afterAll(async () => {
  await h.close();
});

const find = (all: LaunchCheck[], code: string) => all.find((c) => c.code === code);

describe('the launch check (owner 1405/07/23)', () => {
  it('passes the application role; fails a connection that owns the tables', async () => {
    const all = await checks.run();
    expect(find(all, 'app_role')).toMatchObject({ item: 1, status: 'pass' });
    expect(find(all, 'app_role')?.detail).toMatch(
      /^sepehr_app: superuser false, bypassrls false, owns 0 tables$/,
    );
    const asOwner = await checks.appRole(drizzle(h.owner) as unknown as Database);
    expect(asOwner.status).toBe('fail');
    expect(asOwner.detail).toMatch(/owns [1-9][0-9]* tables/);
  });

  it('reports each identity flag as configured: off by default, a launch blocker', async () => {
    const all = await checks.run();
    for (const key of [
      'identity.reauth',
      'identity.factor_change_sms',
      'identity.staff_mobile_required',
    ]) {
      const { value } = await h.app
        .get<ConfigPort>(CONFIG, { strict: false })
        .resolve(key as 'identity.reauth');
      expect(find(all, key)).toMatchObject({
        item: 2,
        status: value.enabled ? 'pass' : 'fail',
        detail: value.enabled ? 'on' : 'off',
      });
    }
  });

  it('two-person mobile approval: fail with fewer than 2 holders, warn with 2, pass with 3', async () => {
    const before = (await checks.mobileApprovers()).detail;
    expect(before).toMatch(/^0 holders/);
    expect((await checks.mobileApprovers()).status).toBe('fail');
    const code = `mobile_${Math.random().toString(36).slice(2, 10)}`;
    await h.app.get(AccessService).createRole(CLI_ACTOR, {
      code,
      name: 'تأیید شماره بیمار',
      permissions: ['lead.approve_person_mobile'],
      reason: 'test fixture',
    });
    const holders = await Promise.all([1, 2, 3].map(() => loggedInAccount(h, 'staff')));
    await grantRole(h, holders[0]?.id ?? '', code);
    expect((await checks.mobileApprovers()).status).toBe('fail');
    await grantRole(h, holders[1]?.id ?? '', code);
    expect(await checks.mobileApprovers()).toMatchObject({ status: 'warn', detail: /^2 holders/ });
    await grantRole(h, holders[2]?.id ?? '', code);
    expect(await checks.mobileApprovers()).toMatchObject({ status: 'pass', detail: /^3 holders/ });
  });

  it('lost-mobile changers: 2 to 3 named holders, never an advisor or support (owner 1405/07/26)', async () => {
    // Flag off (as migrated): no holder yet is a warning, not a block.
    expect(await checks.patientMobileChangers(new Date())).toMatchObject({
      item: 13,
      status: 'warn',
      detail: /^0 holders \(2 to 3\), 0 also advisor or support; flag off$/,
    });
    // With the flag on, fewer than two holders block the launch.
    const flagOn = new LaunchChecks(
      h.app.get<Database>(DATABASE),
      {
        resolve: () => Promise.resolve({ value: { enabled: true } }),
      } as unknown as ConfigPort,
      h.app.get<AccessPort>(ACCESS_PORT, { strict: false }),
      h.app.get(FieldReencryptionRegistry, { strict: false }),
      h.app.get<CenterDirectory>(CENTER_DIRECTORY, { strict: false }),
    );
    expect(await flagOn.patientMobileChangers(new Date())).toMatchObject({
      status: 'fail',
      detail: /flag on$/,
    });
    const code = `changer_${Math.random().toString(36).slice(2, 10)}`;
    await h.app.get(AccessService).createRole(CLI_ACTOR, {
      code,
      name: 'تغییر شماره بیمار',
      permissions: ['identity.change_patient_mobile'],
      reason: 'test fixture',
    });
    const people = await Promise.all([1, 2, 3, 4].map(() => loggedInAccount(h, 'staff')));
    const id = (i: number) => people[i]?.id ?? '';
    await grantRole(h, id(0), code);
    expect((await checks.patientMobileChangers(new Date())).status).toBe('warn');
    await grantRole(h, id(1), code);
    expect((await checks.patientMobileChangers(new Date())).status).toBe('pass');
    await grantRole(h, id(2), code);
    expect(await checks.patientMobileChangers(new Date())).toMatchObject({
      status: 'pass',
      detail: /^3 holders/,
    });
    await grantRole(h, id(3), code);
    expect((await checks.patientMobileChangers(new Date())).status).toBe('warn');
    // A holder who is also support fails, whatever the count.
    await grantRole(h, id(3), 'support');
    expect(await checks.patientMobileChangers(new Date())).toMatchObject({
      status: 'fail',
      detail: /, 1 also advisor or support;/,
    });
  });

  it('legal texts: a sample template or a draft consent text warns, before the first real contract (owner 1405/07/27, 1405/08/02)', async () => {
    // As migrated: the sample template and the sample consent text.
    expect(await checks.legalTexts(new Date())).toMatchObject({
      item: 14,
      status: 'warn',
      detail:
        'before the first real contract (owner 1405/08/02): awaiting counsel: contract.loan_template, credit.consent_text',
    });
    const config = (template: boolean, text: string) =>
      new LaunchChecks(
        h.app.get<Database>(DATABASE),
        {
          resolve: (key: string) =>
            Promise.resolve({
              value: key === 'contract.loan_template' ? { sample: template } : { text },
            }),
        } as unknown as ConfigPort,
        h.app.get<AccessPort>(ACCESS_PORT, { strict: false }),
        h.app.get(FieldReencryptionRegistry, { strict: false }),
        h.app.get<CenterDirectory>(CENTER_DIRECTORY, { strict: false }),
      );
    const approved = 'اینجانب با بررسی اطلاعات اعتباری خود موافقت می‌کنم.';
    expect((await config(false, approved).legalTexts(new Date())).status).toBe('pass');
    expect(await config(true, approved).legalTexts(new Date())).toMatchObject({
      status: 'warn',
      detail: /awaiting counsel: contract\.loan_template$/,
    });
    expect(
      await config(false, `پیش‌نویس — در انتظار تأیید حقوقی: ${approved}`).legalTexts(new Date()),
    ).toMatchObject({ status: 'warn', detail: /awaiting counsel: credit\.consent_text$/ });
  });

  it('holidays (owner 1405/07/27, 1405/08/02): one who asks and two different people who decide, else a block', async () => {
    const holding = (askers: string[], deputies: string[] = []) =>
      new LaunchChecks(
        h.app.get<Database>(DATABASE),
        h.app.get<ConfigPort>(CONFIG, { strict: false }),
        {
          holdersOfPermission: (p: string) =>
            Promise.resolve(
              p === 'config.manage_holidays'
                ? askers
                : p === 'config.approve_holidays'
                  ? deputies
                  : [],
            ),
        } as unknown as AccessPort,
        h.app.get(FieldReencryptionRegistry, { strict: false }),
        h.app.get<CenterDirectory>(CENTER_DIRECTORY, { strict: false }),
      );
    expect(await holding([]).holidayHolders()).toMatchObject({ item: 10, status: 'fail' });
    expect((await holding(['a']).holidayHolders()).status).toBe('fail');
    // A deputy alone asks for nothing.
    expect((await holding([], ['d', 'e']).holidayHolders()).status).toBe('fail');
    // The same person holding both is still one person.
    expect((await holding(['a'], ['a']).holidayHolders()).status).toBe('fail');
    expect(await holding(['a', 'b']).holidayHolders()).toMatchObject({
      status: 'pass',
      detail: /^2 may ask, 2 may decide \(at least 1 and 2/,
    });
    expect(await holding(['a'], ['d']).holidayHolders()).toMatchObject({
      status: 'pass',
      detail: /^1 may ask, 2 may decide/,
    });
    // 0097 gave it to the general manager's role; 0105 ended the system admin's.
    const { rows } = await h.owner.query<Row>(
      `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission_code = 'config.manage_holidays' AND rp.deleted_at IS NULL ORDER BY 1`,
    );
    expect(rows.map((r) => r['code'])).toEqual(['ceo']);
  });

  it('contract terms (owner 1405/07/27): every active center and workplace has its own approved term, else a block', async () => {
    const withParties = (
      parties: { centers: string[]; workplaces: { nodeId: string; centerNodeId: string | null }[] },
      terms: Record<string, { level: string; startsOn: string | null }>,
    ) =>
      new LaunchChecks(
        h.app.get<Database>(DATABASE),
        {
          resolve: (_key: string, scope: { doctorNodeId?: string; centerNodeId?: string }) => {
            const t = (scope.doctorNodeId ? terms[scope.doctorNodeId] : undefined) ??
              (scope.centerNodeId ? terms[scope.centerNodeId] : undefined) ?? {
                level: 'global',
                startsOn: null,
              };
            return Promise.resolve({
              level: t.level,
              value: { startsOn: t.startsOn, months: t.startsOn ? 12 : null },
            });
          },
        } as unknown as ConfigPort,
        h.app.get<AccessPort>(ACCESS_PORT, { strict: false }),
        h.app.get(FieldReencryptionRegistry, { strict: false }),
        { contractParties: () => Promise.resolve(parties) } as unknown as CenterDirectory,
      );
    const parties = {
      centers: ['c1'],
      workplaces: [
        { nodeId: 'd1', centerNodeId: 'c1' },
        { nodeId: 'd2', centerNodeId: null },
      ],
    };
    const all = {
      c1: { level: 'center', startsOn: '2026-10-01' },
      d1: { level: 'doctor', startsOn: '2026-10-01' },
      d2: { level: 'doctor', startsOn: '2026-10-01' },
    };
    expect(await withParties(parties, all).contractTerms(new Date())).toMatchObject({
      item: 15,
      status: 'pass',
    });
    // The center without one.
    const noCenter = { d1: all.d1, d2: all.d2 };
    expect(await withParties(parties, noCenter).contractTerms(new Date())).toMatchObject({
      status: 'fail',
      detail: /^1 of 1 active centers/,
    });
    // A doctor only covered by the center's term: not their own.
    const noDoctor = { c1: all.c1, d2: all.d2 };
    expect(await withParties(parties, noDoctor).contractTerms(new Date())).toMatchObject({
      status: 'fail',
      detail: /and 1 of 2 workplaces/,
    });
    // A term recorded as none: missing too.
    expect(
      (
        await withParties(parties, {
          ...all,
          d2: { level: 'doctor', startsOn: null },
        }).contractTerms(new Date())
      ).status,
    ).toBe('fail');
  });

  it('offboarding: warn until one may ask and another may approve (owner 1405/07/23, plan 4)', async () => {
    expect(await checks.staffOffboarders()).toMatchObject({
      item: 8,
      status: 'warn',
      detail: /^0 may ask, 0 may approve/,
    });
    const both = `off_${Math.random().toString(36).slice(2, 10)}`;
    await h.app.get(AccessService).createRole(CLI_ACTOR, {
      code: both,
      name: 'خروج کارمند',
      permissions: ['identity.request_staff_offboarding', 'identity.approve_staff_offboarding'],
      reason: 'test fixture',
    });
    const [first, second] = await Promise.all([1, 2].map(() => loggedInAccount(h, 'staff')));
    // One person holding both is not two people.
    await grantRole(h, first?.id ?? '', both);
    expect((await checks.staffOffboarders()).status).toBe('warn');
    await grantRole(h, second?.id ?? '', both);
    expect(await checks.staffOffboarders()).toMatchObject({
      status: 'pass',
      detail: /^2 may ask, 2 may approve/,
    });
  });

  it('blind indexes: pass under one key; warn when a column holds two', async () => {
    expect((await checks.blindIndexKeys()).status).toBe('pass');
    const { rows } = await h.owner.query<Row>(
      `INSERT INTO persons (national_id_enc, national_id_index, national_id_last4)
       VALUES ('k2.c2lnbmVk', 'k2.aW5kZXgtdHdv', '0000'), ('v1.c2lnbmVk', 'v1.aW5kZXgtb25l', '0000')
       RETURNING id`,
    );
    const warned = await checks.blindIndexKeys();
    expect(warned.status).toBe('warn');
    expect(warned.detail).toMatch(/persons\.national_id_index: k2 1, v1 1/);
    // Test rows only: soft-deleted again, as rule 7 asks.
    await h.owner.query('UPDATE persons SET deleted_at = now() WHERE id = ANY($1)', [
      rows.map((r) => r['id']),
    ]);
    expect((await checks.blindIndexKeys()).status).toBe('pass');
  });

  it('migrations: read as the migration role they pass; the application role alone warns, never passes blind', async () => {
    const asApp = await checks.migrations();
    expect(asApp.status).toBe('warn');
    expect(asApp.detail).toMatch(/cannot read the applied list \(set MIGRATION_DATABASE_URL\)$/);
    const migrationDb = drizzle(h.owner) as unknown as Database;
    const all = await checks.run(new Date(), migrationDb);
    const migrations = find(all, 'migrations');
    expect(migrations?.status).toBe('pass');
    expect(migrations?.detail).toMatch(/^(\d+) applied of \1 \(read as the migration role\)$/);
    // One migration fewer applied than this build holds: a fail, not a pass.
    const fewer = await checks.migrations({
      execute: () =>
        Promise.resolve({
          rows: [{ n: Number(/^(\d+)/.exec(migrations?.detail ?? '')?.[1]) - 1 }],
        }),
    } as unknown as Database);
    expect(fewer.status).toBe('fail');
  });

  it('the failed-queue threshold is reported, to be routed in Grafana', async () => {
    expect(find(await checks.run(), 'ops.queue_alert_thresholds')).toMatchObject({
      item: 6,
      status: 'warn',
    });
  });

  it('clocks (owner 1405/07/29): the database within a second of this host, else a block', async () => {
    // This host's offset from the database (a container's clock may run seconds apart).
    const read = async () => {
      const { rows } = await h.owner.query<{ ms: string }>(
        `SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms`,
      );
      return Number(rows[0]?.ms);
    };
    const offset = (await read()) - Date.now();
    const inStep = await checks.clockSkew(() => Date.now() + offset);
    expect(inStep).toMatchObject({ item: 16, code: 'clock_skew', status: 'pass' });
    const behind = await checks.clockSkew(() => Date.now() + offset + 5_000);
    expect(behind.status).toBe('fail');
    expect(behind.detail).toMatch(/^database clock behind by (4[0-9]{3}|5[0-9]{3}) ms/);
    const ahead = await checks.clockSkew(() => Date.now() + offset - 5_000);
    expect(ahead.status).toBe('fail');
    expect(ahead.detail).toMatch(/^database clock ahead by/);
    // Just inside the bound: still a pass.
    expect((await checks.clockSkew(() => Date.now() + offset - 600)).status).toBe('pass');
    expect(find(await checks.run(), 'clock_skew')?.item).toBe(16);
  });

  it('the cheque rule (owner, ج۵): warns while either number is 0, passes once both are set', async () => {
    const rule = async () =>
      (await checks.run()).filter((c) => c.code.startsWith('instrument.') && c.item === 17);
    expect(await rule()).toEqual([
      expect.objectContaining({ code: 'instrument.borrower_cheque_min_count', status: 'warn' }),
      expect.objectContaining({ code: 'instrument.guarantee_cheque_min_bps', status: 'warn' }),
    ]);
    // The annex's launch values (as two people would approve them in the panel).
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('instrument.borrower_cheque_min_count', 'global', '1', now() - interval '1 hour',
               'approved', 'آزمون', now())`,
    );
    const half = await rule();
    expect(half.map((c) => c.status)).toEqual(['pass', 'warn']);
    expect(half[0]?.detail).toBe('1');
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('instrument.guarantee_cheque_min_bps', 'global', '11000', now() - interval '1 hour',
               'approved', 'آزمون', now())`,
    );
    expect(await rule()).toEqual([
      expect.objectContaining({ status: 'pass', detail: '1' }),
      expect.objectContaining({ status: 'pass', detail: '11000' }),
    ]);
    // Never a block.
    expect((await checks.run()).filter((c) => c.item === 17 && c.status === 'fail')).toEqual([]);
  });

  it('split reviewers (owner 1405/08/01, ADR-050): warns below two holders, passes with two', async () => {
    const before = await checks.costSplitReviewers();
    expect(before).toMatchObject({ item: 19, status: 'warn', detail: /^0 holders/ });
    const [a, b] = await Promise.all([1, 2].map(() => loggedInAccount(h, 'staff')));
    await grantRole(h, a?.id ?? '', 'credit_specialist');
    expect(await checks.costSplitReviewers()).toMatchObject({
      status: 'warn',
      detail: /^1 holders/,
    });
    await grantRole(h, b?.id ?? '', 'case_completion');
    expect(await checks.costSplitReviewers()).toMatchObject({
      status: 'pass',
      detail: /^2 holders/,
    });
    expect(find(await checks.run(), 'credit.review_cost_split')).toMatchObject({ status: 'pass' });
  });

  it('the borrower cap (ADR-051): warns while it is "0", passes once set', async () => {
    expect(await checks.borrowerCap(new Date())).toMatchObject({ item: 20, status: 'warn' });
    // The annex's launch value (as two people would approve it in the panel).
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('credit.borrower_exposure_cap', 'global',
               '{"capRial": "1500000000", "basis": "obligation", "includeApprovedUnfunded": true}',
               now() - interval '1 hour', 'approved', 'آزمون', now())`,
    );
    expect(await checks.borrowerCap(new Date())).toMatchObject({
      status: 'pass',
      detail: '1500000000 (obligation)',
    });
  });

  it('writes nothing', async () => {
    const count = async () =>
      (
        await h.owner.query<Row>(
          `SELECT (SELECT count(*) FROM audit_events)::int AS audit,
                  (SELECT count(*) FROM access_logs)::int AS views,
                  (SELECT count(*) FROM config_values)::int AS config`,
        )
      ).rows[0];
    const before = await count();
    await checks.run();
    expect(await count()).toEqual(before);
  });

  it('owner 1405/08/02: the accepted risk and the two settings before first use are warnings on every run', async () => {
    const all = await checks.run();
    for (const [item, code] of [
      [21, 'pentest_risk_accepted'],
      [22, 'scoring_rules'],
      [23, 'lunar_holidays'],
      [24, 'financial_step_up_sms'],
    ] as const) {
      expect(all.find((c) => c.code === code)).toMatchObject({ item, status: 'warn' });
    }
    expect(all.find((c) => c.code === 'pentest_risk_accepted')?.detail).toMatch(
      /risk accepted by the owner on 1405\/08\/02/,
    );
  });

  it('ADR-052 item 26: the step-up template is read from the environment, never fixed in the code', () => {
    expect(stepUpTemplateCheck({ SMS_PROVIDER: 'kavenegar' })).toMatchObject({
      item: 26,
      status: 'fail',
    });
    expect(stepUpTemplateCheck({})).toMatchObject({ status: 'fail' });
    expect(
      stepUpTemplateCheck({ SMS_PROVIDER: 'kavenegar', KAVENEGAR_STEP_UP_TEMPLATE: 'any-name-7' }),
    ).toMatchObject({ status: 'pass', detail: 'KAVENEGAR_STEP_UP_TEMPLATE=any-name-7' });
    expect(stepUpTemplateCheck({ SMS_PROVIDER: 'fake', DEPLOY_ENV: 'staging' }).status).toBe(
      'warn',
    );
    // The owner's template name lives in the deployment guide and the environment only.
    const repo = path.resolve(__dirname, '../../../..');
    const sources = ['apps/api/src', 'apps/worker/src'].flatMap((dir) =>
      readdirSync(path.join(repo, dir), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.ts'))
        .map((f) => readFileSync(path.join(repo, dir, f), 'utf8')),
    );
    expect(sources.filter((s) => s.includes('sepehrappverify1'))).toEqual([]);
  });

  it('ADR-052 item 27: financial signers without their own verified mobile warn, counted, no names', async () => {
    const signer = await loggedInAccount(h, 'staff');
    await grantRole(h, signer.id, 'accounting');
    const before = await checks.signerMobiles();
    expect(before).toMatchObject({ item: 27, status: 'warn' });
    const missing = (c: LaunchCheck) => Number(/, (\d+) without/.exec(c.detail)?.[1]);
    expect(missing(before)).toBeGreaterThanOrEqual(1);
    await h.owner.query(
      'UPDATE user_accounts SET mobile = $2, mobile_verified_at = now() WHERE id = $1',
      [signer.id, `912${String(Date.now()).slice(-7)}`],
    );
    expect(missing(await checks.signerMobiles())).toBe(missing(before) - 1);
    expect(find(await checks.run(), 'signer_mobiles')?.item).toBe(27);
  });

  it('ADR-052 item 28: the SMS credit alert warns while "0", passes once set', async () => {
    expect(await checks.smsCreditAlert(new Date())).toMatchObject({ item: 28, status: 'warn' });
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('notification.sms_credit_alert_rial', 'global', '"5000000"',
               now() - interval '1 hour', 'approved', 'آزمون', now())`,
    );
    expect(await checks.smsCreditAlert(new Date())).toMatchObject({
      status: 'pass',
      detail: '5000000 rials',
    });
  });

  it('owner 1405/08/03 item 29: the SMS code warns while off, passes once on', async () => {
    // The tests run it on; 0106 ships it off (a later version, as two people would approve it).
    expect(await checks.financialStepUp(new Date())).toMatchObject({ item: 29, status: 'pass' });
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('identity.financial_step_up', 'global',
               '{"enabled": false, "codeTtlSeconds": 120, "maxAttempts": 5, "lockoutSeconds": 900,
                 "resendAfterSeconds": 60, "maxSendsPerHour": 3, "mobileChangeDelayHours": 24}',
               now() - interval '1 second', 'approved', 'آزمون', now())`,
    );
    expect(await checks.financialStepUp(new Date())).toMatchObject({
      status: 'warn',
      detail: /^off: financial approvals need no code/,
    });
    expect(find(await checks.run(), 'identity.financial_step_up')?.item).toBe(29);
  });

  it('owner 1405/08/03 item 30: three distinct approvers of a signer’s mobile, else a warning', async () => {
    const pending = await checks.mobileChangeApprovers();
    expect(pending).toMatchObject({ item: 30, status: 'warn' });
    expect(pending.detail).toContain('pending');
    const [chief, admin, third] = await Promise.all(
      [1, 2, 3].map(() => loggedInAccount(h, 'staff')),
    );
    await grantRole(h, chief?.id ?? '', 'ceo');
    await grantRole(h, admin?.id ?? '', 'system_admin');
    await grantRole(h, third?.id ?? '', 'mobile_change_approver');
    expect(await checks.mobileChangeApprovers()).toMatchObject({ status: 'pass' });
    // The third approver is also the CEO: three distinct people are needed.
    await grantRole(h, chief?.id ?? '', 'mobile_change_approver');
    const overlap = await checks.mobileChangeApprovers();
    expect(overlap.status).toBe('warn');
    expect(overlap.detail).toContain('سه نفر متمایز لازم است');
    // Owner 1405/08/03 (الف): nor a holder of a financial signing permission.
    const access = (roles: Record<string, string[]>, signer: string): AccessPort =>
      ({
        holdersOf: (role: string) => Promise.resolve(roles[role] ?? []),
        holdersOfPermission: () => Promise.resolve(['c', 'a', 't']),
        resolve: (id: string) =>
          Promise.resolve({
            accountId: id,
            roles: [],
            scopes: [],
            permissions: new Set(id === signer ? ['repayment.approve_payment'] : []),
          }),
      }) as unknown as AccessPort;
    const withAccess = (port: AccessPort) =>
      new LaunchChecks(
        h.app.get<Database>(DATABASE),
        h.app.get<ConfigPort>(CONFIG, { strict: false }),
        port,
        h.app.get(FieldReencryptionRegistry, { strict: false }),
        h.app.get<CenterDirectory>(CENTER_DIRECTORY, { strict: false }),
      );
    const roles = { ceo: ['c'], system_admin: ['a'], mobile_change_approver: ['t'] };
    expect(await withAccess(access(roles, 'nobody')).mobileChangeApprovers()).toMatchObject({
      status: 'pass',
    });
    const signs = await withAccess(access(roles, 't')).mobileChangeApprovers();
    expect(signs.status).toBe('warn');
    expect(signs.detail).toContain('financial signing permission');
  });

  it('owner 1405/08/03 item 31: a technical-settings approver who is not a system administrator', async () => {
    const before = await checks.technicalConfigApprovers();
    expect(before).toMatchObject({ item: 31, status: 'warn' });
    expect(before.detail).toMatch(/^0 technical-settings approvers/);
    const [a, b] = await Promise.all([1, 2].map(() => loggedInAccount(h, 'staff')));
    await grantRole(h, a?.id ?? '', 'technical_config_approver');
    expect(await checks.technicalConfigApprovers()).toMatchObject({ status: 'pass' });
    await grantRole(h, b?.id ?? '', 'technical_config_approver');
    await grantRole(h, b?.id ?? '', 'system_admin');
    const mixed = await checks.technicalConfigApprovers();
    expect(mixed.status).toBe('warn');
    expect(mixed.detail).toContain('1 also system administrators');
    expect(find(await checks.run(), 'config.approve_technical')?.item).toBe(31);
  });

  it('the SMS provider (owner 1405/08/02): the printing fake fails outside staging', () => {
    expect(smsProviderCheck({ SMS_PROVIDER: 'fake', NODE_ENV: 'production' })).toMatchObject({
      item: 25,
      status: 'fail',
    });
    expect(smsProviderCheck({ SMS_PROVIDER: 'fake', NODE_ENV: 'development' }).status).toBe('fail');
    expect(smsProviderCheck({ SMS_PROVIDER: 'fake', DEPLOY_ENV: 'staging' }).status).toBe('warn');
    expect(smsProviderCheck({ SMS_PROVIDER: 'kavenegar' }).status).toBe('pass');
    expect(smsProviderCheck({}).status).toBe('pass');
    expect(smsProviderCheck({ SMS_PROVIDER: 'other' }).status).toBe('fail');
  });
});
