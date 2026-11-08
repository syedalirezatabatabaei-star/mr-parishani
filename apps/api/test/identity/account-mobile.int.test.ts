import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { CONFIG } from '../../src/common/config/config.port';
import { ADMIN_NOTICES, type AdminNotices } from '../../src/common/config/admin-notices.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import {
  ACCOUNT_MOBILE_NOTICE,
  AccountMobileCheck,
} from '../../src/modules/access/account-mobile-check';
import { AccessService } from '../../src/modules/access/access.service';
import { DOCTOR_NOT_TOLD_NOTICE, FundingNotifier } from '../../src/modules/wallet/funding-notifier';
import {
  call,
  loggedInAccount,
  newAccount,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
} from './harness';

/**
 * Task 4-6 (owner 1405/07/12; technical task ف۴): a staff or center user proves their own
 * mobile with a code sent to it; a doctor's account is linked, and the center-manager role
 * granted, only with one; those linked before are listed daily for the system admin, and a
 * doctor who could not be told of a funded patient is a notice, not only a log.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 120_000);

afterAll(async () => {
  await h.close();
});

const mobileRow = async (id: string) =>
  (
    await h.owner.query<{ mobile: string | null; verified: boolean }>(
      'SELECT mobile, mobile_verified_at IS NOT NULL AS verified FROM user_accounts WHERE id = $1',
      [id],
    )
  ).rows[0];

describe("a staff or center user's own mobile (task 4-6)", () => {
  it('is set only by the code sent to it; a wrong code changes nothing; recorded by its last four', async () => {
    const who = await loggedInAccount(h, 'staff');
    const as = (method: string, path: string, body?: unknown) =>
      call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });
    expect((await as('GET', '/auth/mobile')).body).toEqual({
      mobileLastFour: null,
      verified: false,
      verifiedAt: null,
    });
    const mobile = newMobile();
    expect((await as('POST', '/auth/mobile/request', { mobile: `0${mobile}` })).status).toBe(202);
    const code = h.sms.lastCodeFor(mobile);
    const wrong = await as('POST', '/auth/mobile/verify', {
      mobile: `0${mobile}`,
      code: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(401);
    expect(await mobileRow(who.id)).toEqual({ mobile: null, verified: false });
    // A code for one mobile never proves another.
    const other = await as('POST', '/auth/mobile/verify', { mobile: `0${newMobile()}`, code });
    expect(other.status).toBe(401);
    const done = await as('POST', '/auth/mobile/verify', { mobile: `0${mobile}`, code });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ mobileLastFour: mobile.slice(-4), verified: true });
    expect(await mobileRow(who.id)).toEqual({ mobile, verified: true });
    const { rows } = await h.owner.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM audit_events
        WHERE entity_id = $1 AND action = 'identity.account_mobile_verified'`,
      [who.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(mobile);
  });

  it('is not changed here for a patient, whose mobile is their login', async () => {
    const mobile = newMobile();
    const login = await otpLogin(h, mobile, 'mobile');
    const token = login.body['accessToken'] as string;
    const res = await call(h, 'POST', '/auth/mobile/request', {
      bearer: token,
      body: { mobile: `0${newMobile()}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('linking and granting need a verified mobile (task 4-6)', () => {
  it("a doctor's account or the center-manager role: refused without, allowed with", async () => {
    const access = h.app.get(AccessService);
    const unproved = await newAccount(h, 'center', { verifiedMobile: false });
    const proved = await newAccount(h, 'center');
    const db = h.app.get<Database>(DATABASE);
    const attach = (accountId: string) =>
      db.transaction((tx) =>
        access.attachDoctorAccount(CLI_ACTOR, randomUUID(), accountId, 'آزمون', tx),
      );
    await expect(attach(unproved.id)).rejects.toMatchObject({
      response: { error: 'account_mobile_unverified' },
    });
    // Past the mobile check: an unknown node is all that stops it.
    await expect(attach(proved.id)).rejects.toMatchObject({ status: 404 });

    const grant = (accountId: string, roleCode: string) =>
      access.assignRole(CLI_ACTOR, {
        accountId,
        roleCode,
        scope: { kind: 'global' },
        reason: 'آزمون',
      });
    await expect(grant(unproved.id, 'center_manager')).rejects.toMatchObject({
      response: { error: 'account_mobile_unverified' },
    });
    expect((await grant(proved.id, 'center_manager')).id).toMatch(/^[0-9a-f-]{36}$/);
    // Other roles are unchanged by it.
    const staff = await newAccount(h, 'staff');
    expect((await grant(staff.id, 'auditor')).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('those already granted without one are counted daily for the system admin, with no names', async () => {
    const unproved = await newAccount(h, 'center', { verifiedMobile: false });
    // Granted before the requirement: written as it stood then.
    await h.owner.query(
      `INSERT INTO role_assignments (account_id, role_id, scope_kind, reason)
       SELECT $1, id, 'global', 'پیش از الزام' FROM roles WHERE code = 'center_manager'`,
      [unproved.id],
    );
    const result = await h.app.get(AccountMobileCheck).run();
    expect(result.notice).toBe('raised');
    expect(result.unverifiedAccounts).toBeGreaterThanOrEqual(1);
    const { rows } = await h.owner.query<{ message: string; audience: string }>(
      `SELECT message, audience_permission AS audience FROM admin_notices
        WHERE code = $1 AND resolved_at IS NULL`,
      [ACCOUNT_MOBILE_NOTICE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.audience).toBe('access.assign_roles');
    expect(rows[0]?.message).not.toMatch(/9\d{9}|center/);
    // Run again: still one open notice.
    await h.app.get(AccountMobileCheck).run();
    const { rows: again } = await h.owner.query(
      'SELECT id FROM admin_notices WHERE code = $1 AND resolved_at IS NULL',
      [ACCOUNT_MOBILE_NOTICE],
    );
    expect(again).toHaveLength(1);
  });
});

describe("a funded patient's doctor who cannot be told (task 4-6, ف۴)", () => {
  it('is a notice for the system admin, not only a log; the patient is still told', async () => {
    const sent: { mobile: string; text: string }[] = [];
    const raised: string[] = [];
    const notices: AdminNotices = {
      raise: (code) => {
        raised.push(code);
        return Promise.resolve();
      },
      resolve: () => Promise.resolve(),
    };
    const notifier = new FundingNotifier(
      { register: () => undefined },
      h.app.get(CONFIG),
      {
        facts: () => Promise.resolve({ patientPersonId: randomUUID() } as never),
        applicationsOf: () => Promise.resolve([]),
      },
      { mobileOf: () => Promise.resolve('9120000001') } as never,
      { find: () => Promise.resolve(null) },
      {
        summary: () =>
          Promise.resolve({ approvedAmountRial: 9_600_000n, downPaymentRial: 2_400_000n } as never),
      } as never,
      {
        schedule: () =>
          Promise.resolve({
            installments: [{ index: 1, dueOn: '2026-11-04', amountRial: 900_000n }],
          } as never),
      } as never,
      {
        sendText: (job) => {
          sent.push(job);
          return Promise.resolve();
        },
      },
      notices,
    );
    const event: EventEnvelope = {
      id: randomUUID(),
      type: 'wallet.funded',
      aggregateType: 'funding_request',
      aggregateId: randomUUID(),
      payload: {
        creditApplicationId: randomUUID(),
        purseId: randomUUID(),
        scheduleId: randomUUID(),
        doctorAccountId: null,
      },
      occurredAt: new Date().toISOString(),
    };
    await h.app.get<Database>(DATABASE).transaction((tx) => notifier.handle(event, tx));
    expect(sent.map((s) => s.mobile)).toEqual(['9120000001']);
    expect(raised).toEqual([DOCTOR_NOT_TOLD_NOTICE]);
    // The real port opens one notice however often it is raised.
    const real = h.app.get<AdminNotices>(ADMIN_NOTICES);
    await real.raise(DOCTOR_NOT_TOLD_NOTICE, 'access.assign_roles', 'آزمون');
    await real.raise(DOCTOR_NOT_TOLD_NOTICE, 'access.assign_roles', 'آزمون');
    const { rows } = await h.owner.query<{ n: number }>(
      `SELECT raise_count AS n FROM admin_notices WHERE code = $1 AND resolved_at IS NULL`,
      [DOCTOR_NOT_TOLD_NOTICE],
    );
    expect(rows).toEqual([{ n: 2 }]);
  });
});
