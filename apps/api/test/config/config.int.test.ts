import { CONFIG_KEYS, type ConfigKey, type PermissionCode } from '@sepehr/contracts';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EffectiveAccess } from '../../src/common/auth/access.port';
import { AUDIT_LOG, type AuditLog } from '../../src/common/audit/audit.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { createPool } from '../../src/db/pool';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ConfigService } from '../../src/modules/config/config.service';
import {
  actorFor,
  call,
  grantRole,
  loggedInAccount,
  newMobile,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

let h: Harness;
let app: Pool;
let strategyA: LoggedInAccount;
let strategyB: LoggedInAccount;
let adminA: LoggedInAccount;
let adminB: LoggedInAccount;

const get = (who: LoggedInAccount, path: string) => call(h, 'GET', path, { bearer: who.access });
const post = (who: LoggedInAccount, path: string, body?: unknown) =>
  call(h, 'POST', path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

/** Proposes through the API as `maker` and approves as `checker`; returns the version. */
async function change(
  maker: LoggedInAccount,
  checker: LoggedInAccount,
  proposal: { key: string; scope?: unknown; value: unknown; effectiveFrom?: string },
) {
  const proposed = await post(maker, '/config/proposals', {
    scope: { level: 'global' },
    reason: 'آزمون پیکربندی',
    ...proposal,
  });
  expect(proposed.status).toBe(201);
  const approved = await post(
    checker,
    `/config/proposals/${proposed.body['id'] as string}/approve`,
  );
  expect(approved.status).toBe(200);
  return approved.body;
}

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
  [strategyA, strategyB, adminA, adminB] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, strategyA.id, 'strategy_manager');
  await grantRole(h, strategyB.id, 'strategy_manager');
  await grantRole(h, adminA.id, 'system_admin');
  await grantRole(h, adminB.id, 'system_admin');
});

afterAll(async () => {
  await app.end();
  await h.close();
});

describe('ACCEPTANCE: a rate changed today leaves an older record’s value alone', () => {
  it('keeps the value a record was locked to, by time and by version', async () => {
    const config = h.app.get(ConfigService);
    // A record (say a cancellation) created before the change locks its version.
    const createdAt = new Date();
    const locked = await config.resolve('repayment.cancellation_penalty_bps', {}, createdAt);
    expect(locked.value).toBe(1800);

    await change(strategyA, strategyB, {
      key: 'repayment.cancellation_penalty_bps',
      // Owner پ۱۳ (task 4-8): 0 to 18%; a lower rate changes it the same way.
      value: 1200,
    });

    const now = await config.resolve('repayment.cancellation_penalty_bps');
    expect(now.value).toBe(1200);
    expect(now.versionId).not.toBe(locked.versionId);
    // The old record: the same answer by its creation time, and by its locked version.
    const byTime = await config.resolve('repayment.cancellation_penalty_bps', {}, createdAt);
    expect(byTime).toEqual(locked);
    const byVersion = await config.getVersion(
      'repayment.cancellation_penalty_bps',
      locked.versionId,
    );
    expect(byVersion.value).toBe(1800);

    const viaApi = await get(
      strategyA,
      `/config/resolve?key=repayment.cancellation_penalty_bps&at=${encodeURIComponent(createdAt.toISOString())}`,
    );
    expect(viaApi.body).toMatchObject({ value: 1800, versionId: locked.versionId });
  });

  it('a value can never be set to start in the past, by the API or in the database', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await post(strategyA, '/config/proposals', {
      key: 'repayment.cancellation_penalty_bps',
      scope: { level: 'global' },
      value: 1500,
      effectiveFrom: past,
      reason: 'تغییر گذشته',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'effective_date_in_past' });

    await expect(
      app.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, reason, proposed_by)
         VALUES ('repayment.cancellation_penalty_bps', 'global', '1500', $1, 'x', $2)`,
        [past, strategyA.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a proposal approved after its start expires instead of rewriting the past', async () => {
    const config = h.app.get(ConfigService);
    const soon = new Date(Date.now() + 60_000);
    const proposal = await config.propose(
      actorFor(strategyA.id),
      accessWith('config.manage_business'),
      {
        key: 'lead.duplicate_window_days',
        scope: { level: 'global' },
        value: 10,
        effectiveFrom: soon.toISOString(),
        reason: 'پنجره طولانی‌تر',
      },
    );
    const later = new Date(soon.getTime() + 1000);
    await expect(
      config.decide(
        actorFor(strategyB.id),
        accessWith('config.manage_business'),
        proposal.id,
        true,
        later,
      ),
    ).rejects.toMatchObject({ status: 410 });
    const [history] = await config.history('lead.duplicate_window_days');
    expect(history).toMatchObject({ id: proposal.id, status: 'expired' });
    expect((await config.resolve('lead.duplicate_window_days', {}, later)).value).toBe(7);
  });

  it('a future value applies from its start, not before', async () => {
    const config = h.app.get(ConfigService);
    const start = new Date(Date.now() + 60 * 60 * 1000);
    await change(adminA, adminB, {
      key: 'audit.retention',
      value: { months: 36 },
      effectiveFrom: start.toISOString(),
    });
    expect((await config.resolve('audit.retention')).value).toEqual({ months: 24 });
    const after = new Date(start.getTime() + 1);
    expect((await config.resolve('audit.retention', {}, after)).value).toEqual({ months: 36 });
  });
});

/** Access holding exactly these permissions, for direct service calls. */
function accessWith(...permissions: PermissionCode[]): EffectiveAccess {
  return { accountId: '', roles: [], permissions: new Set(permissions), scopes: [] };
}

describe('the hierarchy global ← city ← treatment field ← center ← doctor', () => {
  const key = 'settlement.test_fee_bps' as ConfigKey;
  const center = '01a0e1e7-0000-7000-8000-00000000000c';
  const doctor = '01a0e1e7-0000-7000-8000-00000000000d';
  let config: ConfigService;

  beforeAll(async () => {
    // A test-only key settable at every level, as fees will be (doc 06 §3).
    config = new ConfigService(h.app.get<Database>(DATABASE), h.app.get<AuditLog>(AUDIT_LOG), {
      ...CONFIG_KEYS,
      [key]: {
        schema: z.number().int(),
        levels: ['global', 'city', 'treatment_field', 'center', 'doctor'],
        category: 'business',
        sensitive: true,
      },
    });
    await h.owner.query(
      "INSERT INTO config_keys (code, category, sensitive) VALUES ($1, 'business', true)",
      [key],
    );
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ($1, 'global', '100', '2020-01-01Z', 'approved', 'seed', now())`,
      [key],
    );
    const manage = accessWith('config.manage_business');
    const set = async (scope: object, value: unknown) => {
      const p = await config.propose(actorFor(strategyA.id), manage, {
        key,
        scope: scope as never,
        value,
        reason: 'سطح آزمون',
      });
      await config.decide(actorFor(strategyB.id), manage, p.id, true);
    };
    await set({ level: 'city', ref: 'tehran' }, 200);
    await set({ level: 'treatment_field', ref: 'dental' }, 300);
    await set({ level: 'center', ref: center }, 400);
    await set({ level: 'doctor', ref: doctor }, 500);
  });

  afterAll(async () => {
    // The application's own start-up check must not see the test key.
    await h.owner.query('UPDATE config_keys SET deleted_at = now() WHERE code = $1', [key]);
  });

  it('takes the most specific level that has a value', async () => {
    const value = async (scope: object) => (await config.resolve(key, scope)).value;
    expect(await value({})).toBe(100);
    expect(await value({ cityCode: 'shiraz' })).toBe(100);
    expect(await value({ cityCode: 'tehran' })).toBe(200);
    expect(await value({ cityCode: 'tehran', treatmentFieldCode: 'dental' })).toBe(300);
    expect(
      await value({ cityCode: 'tehran', treatmentFieldCode: 'dental', centerNodeId: center }),
    ).toBe(400);
    expect(
      await value({
        cityCode: 'tehran',
        treatmentFieldCode: 'dental',
        centerNodeId: center,
        doctorNodeId: doctor,
      }),
    ).toBe(500);
    expect((await config.resolve(key, { doctorNodeId: doctor })).level).toBe('doctor');
  });

  it('a withdrawn level (null) falls back to the one above', async () => {
    const manage = accessWith('config.manage_business');
    const p = await config.propose(actorFor(strategyA.id), manage, {
      key,
      scope: { level: 'doctor', ref: doctor },
      value: null,
      reason: 'حذف استثنای پزشک',
    });
    await config.decide(actorFor(strategyB.id), manage, p.id, true);
    const resolved = await config.resolve(key, { centerNodeId: center, doctorNodeId: doctor });
    expect(resolved).toMatchObject({ value: 400, level: 'center' });
  });

  it('refuses a level the key does not allow, and a value that does not fit', async () => {
    const res = await post(strategyA, '/config/proposals', {
      key: 'repayment.cancellation_penalty_bps',
      scope: { level: 'city', ref: 'tehran' },
      value: 1000,
      reason: 'نرخ شهر',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'level_not_allowed' });
    const bad = await post(strategyA, '/config/proposals', {
      key: 'repayment.cancellation_penalty_bps',
      scope: { level: 'global' },
      value: 18.5,
      reason: 'نرخ اعشاری',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_value' });
    // Owner پ۱۳ (task 4-8): above 18% only with a new ADR.
    const above = await post(strategyA, '/config/proposals', {
      key: 'repayment.cancellation_penalty_bps',
      scope: { level: 'global' },
      value: 1801,
      reason: 'بیش از سقف',
    });
    expect(above.status).toBe(400);
    expect(above.body).toMatchObject({ error: 'invalid_value' });
    const withdraw = await post(strategyA, '/config/proposals', {
      key: 'repayment.cancellation_penalty_bps',
      scope: { level: 'global' },
      value: null,
      reason: 'حذف مقدار سراسری',
    });
    expect(withdraw.body).toMatchObject({ error: 'global_value_required' });
  });
});

describe('who may change what', () => {
  it('two people for a sensitive key; the same person twice is refused', async () => {
    const proposed = await post(strategyA, '/config/proposals', {
      key: 'lead.duplicate_window_days',
      scope: { level: 'global' },
      value: 14,
      reason: 'پنجره دوهفته‌ای',
    });
    const self = await post(
      strategyA,
      `/config/proposals/${proposed.body['id'] as string}/approve`,
    );
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ error: 'second_person_required' });
    // Nor can the database be talked into it.
    await expect(
      app.query(
        "UPDATE config_values SET status = 'approved', decided_by = proposed_by, decided_at = now(), effective_at = now() WHERE id = $1",
        [proposed.body['id']],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const rejected = await post(
      strategyB,
      `/config/proposals/${proposed.body['id'] as string}/reject`,
    );
    expect(rejected.body).toMatchObject({ status: 'rejected' });
  });

  it('business rules belong to strategy, technical settings to system administration', async () => {
    const business = { key: 'lead.duplicate_window_days', value: 9 };
    const technical = { key: 'audit.retention', value: { months: 30 } };
    for (const [who, proposal] of [
      [adminA, business],
      [strategyA, technical],
    ] as const) {
      const res = await post(who, '/config/proposals', {
        scope: { level: 'global' },
        reason: 'خارج از حوزه',
        ...proposal,
      });
      expect(res.status).toBe(403);
    }
  });

  it('auditors and the CEO read but never change', async () => {
    for (const role of ['auditor', 'ceo']) {
      const reader = await loggedInAccount(h, 'staff');
      await grantRole(h, reader.id, role);
      expect((await get(reader, '/config/keys')).status).toBe(200);
      const res = await post(reader, '/config/proposals', {
        key: 'lead.duplicate_window_days',
        scope: { level: 'global' },
        value: 9,
        reason: 'فقط‌خواندنی',
      });
      expect(res.status).toBe(403);
    }
    const nobody = await loggedInAccount(h, 'staff');
    expect((await get(nobody, '/config/keys')).status).toBe(403);
  });

  it('every change is in the audit trail, with before and after', async () => {
    const config = h.app.get(ConfigService);
    // Money stays a string of rials all the way through (it once came back a number).
    expect((await config.resolve('repayment.rounding_unit_rial')).value).toBe('10000');
    await change(strategyA, strategyB, { key: 'repayment.rounding_unit_rial', value: '50000' });
    expect((await config.resolve('repayment.rounding_unit_rial')).value).toBe('50000');
    const events = await h.app
      .get(AuditService)
      .list({ entityType: 'config', entityId: 'repayment.rounding_unit_rial', limit: 5 });
    expect(events.map((e) => e.action)).toEqual(['config.approved', 'config.proposed']);
    expect(events[0]).toMatchObject({
      actorAccountId: strategyB.id,
      before: { value: '10000' },
      after: { value: '50000' },
    });
  });
});

describe('versions are immutable', () => {
  it('the application may write only the decision, and nobody may rewrite a value', async () => {
    const [row] = (
      await h.owner.query<{ id: string }>(
        "SELECT id FROM config_values WHERE key = 'identity.otp' AND status = 'approved' LIMIT 1",
      )
    ).rows;
    await expect(
      app.query("UPDATE config_values SET value = '{}' WHERE id = $1", [row?.id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      h.owner.query("UPDATE config_values SET value = '{}' WHERE id = $1", [row?.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query(
        "INSERT INTO config_keys (code, category, sensitive) VALUES ('lead.x', 'business', true)",
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the API refuses to start while config_keys and the code differ', async () => {
    const config = h.app.get(ConfigService);
    await expect(config.onApplicationBootstrap()).resolves.toBeUndefined();
    await h.owner.query(
      "UPDATE config_keys SET sensitive = false WHERE code = 'lead.duplicate_window_days'",
    );
    try {
      await expect(config.onApplicationBootstrap()).rejects.toThrow('lead.duplicate_window_days');
    } finally {
      await h.owner.query(
        "UPDATE config_keys SET sensitive = true WHERE code = 'lead.duplicate_window_days'",
      );
    }
  });
});

describe('login limits come from configuration', () => {
  it('a changed OTP lifetime applies to the next code', async () => {
    const before = await call(h, 'POST', '/auth/otp/request', { body: { mobile: newMobile() } });
    expect(before.body).toMatchObject({ expiresInSeconds: 180 });
    await change(adminA, adminB, {
      key: 'identity.otp',
      value: {
        ttlSeconds: 240,
        resendCooldownSeconds: 60,
        sendsPerMobilePerHour: 8,
        sendsPerIpPerHour: 20,
        sendsPerDevicePerHour: 10,
        failuresBeforeLock: 6,
        failuresPerIpPerHour: 30,
      },
    });
    const after = await call(h, 'POST', '/auth/otp/request', { body: { mobile: newMobile() } });
    expect(after.body).toMatchObject({ expiresInSeconds: 240 });
  });
});
