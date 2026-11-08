import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { AccessService } from '../../src/modules/access/access.service';
import { hotp, totpStep } from '../../src/modules/identity/totp';
import {
  call,
  grantRole,
  loggedInAccount,
  newAccount,
  newIp,
  newMobile,
  otpLogin,
  relogin,
  startHarness,
  STAFF_PASSWORD,
  type Harness,
  type LoggedInAccount,
} from './harness';

/**
 * Task 9-3, R1 (ASVS 3.7.1, 4.3.3): a sensitive action needs a TOTP code given again in the
 * same session within `identity.reauth`'s window. The code is taken once (no replay, even of
 * the sign-in code); failures are counted, locked and audited like a sign-in; the window is
 * this session's only and ends with a logout or a password change.
 */

let h: Harness;
let admin: LoggedInAccount;
/** The last TOTP step each account used, so that every new code is a later one. */
const lastStep = new Map<string, number>();

/**
 * The account's next code: a step later than any it used. The API takes the current step and
 * the one after it only, so a third code within one 30-second step waits for the next.
 */
async function nextStep(a: LoggedInAccount) {
  const step = Math.max(totpStep(Date.now()), (lastStep.get(a.id) ?? a.lastStep) + 1);
  while (totpStep(Date.now()) < step - 1) await new Promise((r) => setTimeout(r, 500));
  lastStep.set(a.id, step);
  return step;
}
const nextCode = async (a: LoggedInAccount) => hotp(a.secret, await nextStep(a));

/** A new session of the account, with a code later than any it used. */
async function login(a: LoggedInAccount) {
  const step = await nextStep(a);
  return relogin(h, { ...a, lastStep: step - 1 });
}

/** A new account holding system_admin, signed in. */
async function newAdmin() {
  const a = await loggedInAccount(h, 'staff');
  await grantRole(h, a.id, 'system_admin');
  return a;
}

const as = (a: LoggedInAccount, method: string, path: string, body?: unknown, ip?: string) =>
  call(h, method, path, {
    bearer: a.access,
    ...(body === undefined ? {} : { body }),
    ...(ip ? { ip } : {}),
  });

const reauth = async (a: LoggedInAccount, code?: string, ip?: string) =>
  as(a, 'POST', '/auth/totp/reauth', { code: code ?? (await nextCode(a)) }, ip);

/** The flag as of now (a later row overrides the earlier one). */
const setReauth = (enabled: boolean, windowSeconds = 300) =>
  h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('identity.reauth', 'global', $1::jsonb, $2, 'approved', 'test', $2)`,
    [JSON.stringify({ enabled, windowSeconds }), new Date()],
  );

const count = async (sql: string, params: unknown[] = []) =>
  Number((await h.owner.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

const audits = (action: string, accountId: string) =>
  count(`SELECT count(*) AS n FROM audit_events WHERE action = $1 AND entity_id = $2`, [
    action,
    accountId,
  ]);

/** One of each sensitive action, as `who`; returns the answers. */
async function sensitiveActions(who: LoggedInAccount) {
  const target = await newAccount(h, 'staff');
  const other = await loggedInAccount(h, 'staff');
  return {
    assign: await as(who, 'POST', '/access/assignments', {
      accountId: target.id,
      roleCode: 'support',
      scope: { kind: 'global' },
      reason: 'آزمون بازاحراز',
    }),
    createRole: await as(who, 'POST', '/access/roles', {
      code: `r${String(Date.now())}`,
      name: 'نقش آزمون',
      permissions: ['config.read'],
      reason: 'آزمون بازاحراز',
    }),
    totpReset: await as(who, 'POST', '/identity/totp-resets', {
      targetAccountId: other.id,
      reason: 'گوشی گم شد',
    }),
    propose: await as(who, 'POST', '/config/proposals', {
      key: 'identity.factor_change_sms',
      scope: { level: 'global' },
      value: { enabled: false },
      reason: 'آزمون بازاحراز',
    }),
  };
}

beforeAll(async () => {
  h = await startHarness();
  admin = await loggedInAccount(h, 'staff');
  await grantRole(h, admin.id, 'system_admin');
}, 180_000);

afterAll(async () => {
  await setReauth(false);
  await h.close();
});

beforeEach(async () => {
  await setReauth(true);
});

describe('the flag', () => {
  it('off: sensitive actions need no new code (today)', async () => {
    await setReauth(false);
    const fresh = await newAdmin();
    const answers = await sensitiveActions(fresh);
    for (const [name, res] of Object.entries(answers)) {
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    }
  });
});

describe('a sensitive action', () => {
  it('without a fresh code is refused and writes nothing', async () => {
    const fresh = await newAdmin();
    const before = await Promise.all([
      count('SELECT count(*) AS n FROM role_assignments'),
      count('SELECT count(*) AS n FROM roles'),
      count('SELECT count(*) AS n FROM totp_reset_requests'),
      count(`SELECT count(*) AS n FROM config_values WHERE status = 'pending'`),
    ]);
    const answers = await sensitiveActions(fresh);
    for (const [name, res] of Object.entries(answers)) {
      expect(res.status, name).toBe(403);
      expect(res.body, name).toMatchObject({ error: 'reauth_required' });
    }
    // The fixtures above made accounts, not assignments: nothing of the four was written.
    const after = await Promise.all([
      count('SELECT count(*) AS n FROM role_assignments'),
      count('SELECT count(*) AS n FROM roles'),
      count('SELECT count(*) AS n FROM totp_reset_requests'),
      count(`SELECT count(*) AS n FROM config_values WHERE status = 'pending'`),
    ]);
    expect(after).toEqual(before);
  });

  it('after a code given again in this session is done; past the window it is refused again', async () => {
    const fresh = await newAdmin();
    const given = await reauth(fresh);
    expect(given.status, JSON.stringify(given.body)).toBe(200);
    const until = Date.parse(given.body['reauthenticatedUntil'] as string);
    expect(until - Date.now()).toBeGreaterThan(290_000);
    expect(until - Date.now()).toBeLessThanOrEqual(300_000);
    expect(await audits('identity.reauthenticated', fresh.id)).toBeGreaterThan(0);

    const answers = await sensitiveActions(fresh);
    for (const [name, res] of Object.entries(answers)) {
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    }

    // Ten minutes later (the session's mark moved back): the window has passed.
    await h.owner.query(
      `UPDATE sessions SET reauthenticated_at = reauthenticated_at - interval '10 minutes'
        WHERE account_id = $1 AND reauthenticated_at IS NOT NULL`,
      [fresh.id],
    );
    const late = await sensitiveActions(fresh);
    expect(late.assign.status).toBe(403);
    expect(late.assign.body).toMatchObject({ error: 'reauth_required' });
  });

  it('is refused by the service itself, without the controller (rule 12); the CLI is not asked', async () => {
    const target = await newAccount(h, 'staff');
    const input = {
      accountId: target.id,
      roleCode: 'support',
      scope: { kind: 'global' as const },
      reason: 'آزمون',
    };
    await expect(
      h.app.get(AccessService).assignRole(
        {
          accountId: admin.id,
          sessionId: admin.id,
          ip: null,
          roles: [],
          reauthenticatedAt: null,
        },
        input,
      ),
    ).rejects.toMatchObject({ response: { error: 'reauth_required' } });
    const granted = await h.app.get(AccessService).assignRole(CLI_ACTOR, input);
    expect(granted.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the code', () => {
  it('is taken once: the sign-in code is refused, and of two at once only one wins', async () => {
    const fresh = await newAdmin();
    // The code this session signed in with.
    const replay = await reauth(fresh, hotp(fresh.secret, fresh.lastStep));
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ error: 'invalid_code' });
    expect(await audits('identity.reauth_failed', fresh.id)).toBe(1);

    const code = await nextCode(fresh);
    const [a, b] = await Promise.all([reauth(fresh, code), reauth(fresh, code)]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it('wrong: audited and counted; after the lock even a right code is refused', async () => {
    const victim = await loggedInAccount(h, 'staff');
    const ip = newIp();
    for (let i = 0; i < 5; i++) {
      const wrong = await reauth(victim, '000000', ip);
      expect(wrong.status).toBe(401);
    }
    // The sixth failure locks (identity.staff_login.failuresBeforeLock = 6).
    const sixth = await reauth(victim, '000000', ip);
    expect(sixth.status).toBe(429);
    const right = await reauth(victim, await nextCode(victim), ip);
    expect(right.status).toBe(429);
    expect(await audits('identity.reauth_failed', victim.id)).toBe(7);
    const reasons = await h.owner.query<{ reason: string }>(
      `SELECT after->>'reason' AS reason FROM audit_events
        WHERE action = 'identity.reauth_failed' AND entity_id = $1`,
      [victim.id],
    );
    expect(reasons.rows.filter((r) => r.reason === 'locked')).toHaveLength(1);
    // Never the code.
    const text = await h.owner.query<{ t: string }>(
      `SELECT coalesce(string_agg(after::text, ''), '') AS t FROM audit_events
        WHERE action = 'identity.reauth_failed' AND entity_id = $1`,
      [victim.id],
    );
    expect(text.rows[0]?.t).not.toContain('000000');
  });

  it('is for staff and center accounts; a patient has none', async () => {
    const login = await otpLogin(h, newMobile(), 'mobile');
    const res = await call(h, 'POST', '/auth/totp/reauth', {
      bearer: login.body['accessToken'] as string,
      body: { code: '123456' },
    });
    expect(res.status).toBe(403);
  });
});

describe('the window', () => {
  it('is this session only', async () => {
    const one = await newAdmin();
    const two = await login(one);
    expect((await reauth(one)).status).toBe(200);
    const target = await newAccount(h, 'staff');
    const fromTwo = await as(two, 'POST', '/access/assignments', {
      accountId: target.id,
      roleCode: 'support',
      scope: { kind: 'global' },
      reason: 'نشست دیگر',
    });
    expect(fromTwo.status).toBe(403);
    expect(fromTwo.body).toMatchObject({ error: 'reauth_required' });
  });

  it('ends with a password change, and with a logout', async () => {
    const own = await loggedInAccount(h, 'staff');
    await grantRole(h, own.id, 'system_admin');
    expect((await reauth(own)).status).toBe(200);
    const changed = await as(own, 'POST', '/auth/password', {
      currentPassword: STAFF_PASSWORD,
      newPassword: 'another long enough passphrase',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const target = await newAccount(h, 'staff');
    const body = {
      accountId: target.id,
      roleCode: 'support',
      scope: { kind: 'global' },
      reason: 'پس از تغییر گذرواژه',
    };
    const after = await as(own, 'POST', '/access/assignments', body);
    expect(after.status).toBe(403);
    expect(after.body).toMatchObject({ error: 'reauth_required' });

    expect((await reauth(own)).status).toBe(200);
    expect((await as(own, 'POST', '/auth/logout')).status).toBe(204);
    expect((await as(own, 'POST', '/access/assignments', body)).status).toBe(401);
  });
});
