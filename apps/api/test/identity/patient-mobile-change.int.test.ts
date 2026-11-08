import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../src/common/audit/audit.port';
import type { AuthContext } from '../../src/common/auth/auth.decorators';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import { LEAD_CASES, type LeadCases } from '../../src/common/lead/lead-cases.port';
import {
  PERSON_MOBILE_CHANGE,
  type PersonMobileChange,
} from '../../src/common/lead/person-mobile-change.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { REDIS } from '../../src/infra/redis.module';
import { FactorNotices } from '../../src/modules/identity/factor-notices';
import { OtpChallengeService } from '../../src/modules/identity/otp-challenge.service';
import { PatientMobileService } from '../../src/modules/identity/patient-mobile.service';
import { PersonService } from '../../src/modules/lead/person.service';
import { call, loggedInAccount, newMobile, otpLogin, startHarness, type Harness } from './harness';

/**
 * ف۱۲ (owner 1405/07/26, option «ب»): a signed-in patient replaces their login mobile with
 * one proved by a code sent to it; the previous one is told; advertising consent is not
 * carried over; open cases stay on the Person. Limits: the login code's own, one per account,
 * an active (recent) sign-in and a wait between changes.
 */

let h: Harness;
let db: Database;

async function setConfig(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2::jsonb, $3, 'approved', 'آزمون', $3)`,
    [key, JSON.stringify(value), new Date()],
  );
}

const ON = { enabled: true, recentLoginSeconds: 600, cooldownDays: 0 };

beforeAll(async () => {
  h = await startHarness();
  db = h.app.get<Database>(DATABASE);
}, 120_000);

afterAll(async () => {
  await h.close();
});

/** A second sign-in with one mobile, within the resend cooldown: the test clears it. */
async function clearCooldowns(mobile: string) {
  const redis = h.app.get<Redis>(REDIS);
  const keys = await redis.keys(`*cooldown*${mobile}*`);
  if (keys.length > 0) await redis.del(...keys);
}

/** A patient signed in on the mobile app: their account, person and access token. */
async function patient(mobile = newMobile()) {
  await clearCooldowns(mobile);
  const login = await otpLogin(h, mobile, 'mobile');
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const token = login.body['accessToken'] as string;
  const { rows } = await h.owner.query<{ id: string; person_id: string | null }>(
    `SELECT id, person_id FROM user_accounts WHERE kind = 'patient' AND mobile = $1`,
    [mobile],
  );
  const row = rows[0];
  if (!row) throw new Error('no patient account');
  return { mobile, token, accountId: row.id, personId: row.person_id };
}

const as = (token: string, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: token, ...(body === undefined ? {} : { body }) });

const accountMobile = async (id: string) =>
  (await h.owner.query<{ mobile: string }>('SELECT mobile FROM user_accounts WHERE id = $1', [id]))
    .rows[0]?.mobile;

const mobilesOf = async (personId: string) =>
  (
    await h.owner.query<{
      mobile: string;
      status: string;
      added_via: string | null;
      deleted: boolean;
      proved: boolean;
    }>(
      `SELECT mobile, status, added_via, deleted_at IS NOT NULL AS deleted,
              proved_at IS NOT NULL AS proved
         FROM person_mobiles WHERE person_id = $1 ORDER BY created_at, id`,
      [personId],
    )
  ).rows;

describe("a patient's own mobile change (f12, option «ب»)", () => {
  it('is off until the flag is on; never for staff', async () => {
    const p = await patient();
    const off = await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${newMobile()}` });
    expect(off.status).toBe(403);
    expect(off.body['error']).toBe('feature_disabled');
    await setConfig('identity.patient_mobile_change', ON);
    const staff = await loggedInAccount(h, 'staff');
    const refused = await as(staff.access, 'POST', '/me/mobile/request', {
      mobile: `0${newMobile()}`,
    });
    expect(refused.status).toBe(403);
    expect(refused.body['error']).toBe('patients_only');
  });

  it('moves the login and the Person to the proved mobile; tells the previous one; ends the other sessions', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    expect(p.personId).not.toBeNull();
    const personId = p.personId ?? '';
    // A second session of the same patient (another device): ended by the change.
    await clearCooldowns(p.mobile);
    const other = await otpLogin(h, p.mobile, 'mobile');
    const otherToken = other.body['accessToken'] as string;
    // Advertising consent given on the previous mobile.
    await h.owner.query(
      `INSERT INTO sms_consents (mobile, person_id, action, source) VALUES ($1, $2, 'consent', 'link')`,
      [p.mobile, personId],
    );
    const to = newMobile();

    expect(
      (await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${p.mobile}` })).body,
    ).toEqual(expect.objectContaining({ error: 'same_mobile' }));
    const asked = await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${to}` });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const code = h.sms.lastCodeFor(to);
    // A wrong code, or the right code for another mobile, changes nothing.
    const wrong = await as(p.token, 'POST', '/me/mobile/verify', {
      mobile: `0${to}`,
      code: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(401);
    expect(
      (await as(p.token, 'POST', '/me/mobile/verify', { mobile: `0${newMobile()}`, code })).status,
    ).toBe(401);
    expect(await accountMobile(p.accountId)).toBe(p.mobile);

    const done = await as(p.token, 'POST', '/me/mobile/verify', { mobile: `0${to}`, code });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ mobileLastFour: to.slice(-4), sessionsEnded: 1 });

    // The account's login, and the Person's mobiles: the previous retired (kept), the new
    // one active and proved, on the same Person.
    expect(await accountMobile(p.accountId)).toBe(to);
    expect(await mobilesOf(personId)).toEqual([
      {
        mobile: p.mobile,
        status: 'active',
        added_via: 'person_created',
        deleted: true,
        proved: true,
      },
      { mobile: to, status: 'active', added_via: 'mobile_change', deleted: false, proved: true },
    ]);
    const cases = h.app.get<LeadCases>(LEAD_CASES);
    expect(await cases.personByMobile(to)).toBe(personId);
    expect(await cases.personByMobile(p.mobile)).toBeNull();

    // This session goes on; the other one is over.
    expect((await as(p.token, 'GET', '/auth/sessions')).status).toBe(200);
    expect((await as(otherToken, 'GET', '/auth/sessions')).status).toBe(401);

    // The previous mobile is told (sent by the worker after the commit).
    const notices = await h.owner.query<{ mobile: string; audience: string }>(
      `SELECT mobile, audience FROM factor_change_notices
        WHERE account_id = $1 AND event = 'patient_mobile_changed'`,
      [p.accountId],
    );
    expect(notices.rows).toEqual([{ mobile: p.mobile, audience: 'patient' }]);

    // Audited by the last four digits only (rule 30).
    const audits = await h.owner.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM audit_events
        WHERE action IN ('identity.patient_mobile_changed', 'lead.person_mobile_replaced')
          AND entity_id IN ($1, $2) ORDER BY created_at, id`,
      [p.accountId, personId],
    );
    expect(audits.rows.map((r) => r.action).sort()).toEqual([
      'identity.patient_mobile_changed',
      'lead.person_mobile_replaced',
    ]);
    const changed = audits.rows.find((r) => r.action === 'identity.patient_mobile_changed');
    expect(changed?.before).toEqual({ mobileLastFour: p.mobile.slice(-4) });
    expect(changed?.after).toEqual({
      mobileLastFour: to.slice(-4),
      method: 'self',
      sessionsEnded: 1,
    });
    expect(JSON.stringify(audits.rows)).not.toContain(p.mobile);
    expect(JSON.stringify(audits.rows)).not.toContain(to);

    // Advertising consent is per mobile and is not carried over.
    const consents = await h.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sms_consents WHERE mobile = $1',
      [to],
    );
    expect(consents.rows[0]?.n).toBe(0);

    // The new mobile signs in to the same account and Person.
    const again = await patient(to);
    expect(again.accountId).toBe(p.accountId);
    expect(again.personId).toBe(personId);
    // The previous mobile no longer opens it: whoever holds it next gets an account and a
    // Person of their own, and sees nothing of this one.
    const next = await patient(p.mobile);
    expect(next.accountId).not.toBe(p.accountId);
    expect(next.personId).not.toBe(personId);
  });

  it('two changes at once of one account: one after the other, one live mobile at the end', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    const [a, b] = [newMobile(), newMobile()];
    await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${a}` });
    await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${b}` });
    const [ca, cb] = [h.sms.lastCodeFor(a), h.sms.lastCodeFor(b)];
    const done = await Promise.all([
      as(p.token, 'POST', '/me/mobile/verify', { mobile: `0${a}`, code: ca }),
      as(p.token, 'POST', '/me/mobile/verify', { mobile: `0${b}`, code: cb }),
    ]);
    expect(done.map((r) => r.status)).toEqual([200, 200]);
    const login = await accountMobile(p.accountId);
    const live = (await mobilesOf(p.personId ?? '')).filter((m) => !m.deleted);
    // The account's login is the Person's one live mobile: none left behind by the other.
    expect(live.map((m) => m.mobile)).toEqual([login]);
  });

  it('says a mobile is taken only after its code is given, and changes nothing then', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const holder = await patient();
    const p = await patient();
    // Another patient's login: the request goes ahead like any other (no oracle).
    const asked = await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${holder.mobile}` });
    expect(asked.status).toBe(202);
    const taken = await as(p.token, 'POST', '/me/mobile/verify', {
      mobile: `0${holder.mobile}`,
      code: h.sms.lastCodeFor(holder.mobile),
    });
    expect(taken.status).toBe(409);
    expect(taken.body['error']).toBe('mobile_taken');

    // A mobile on another Person with no account (an intake): taken as well.
    const persons = h.app.get(PersonService);
    const lone = newMobile();
    expect((await persons.findOrCreateByMobile(lone)).personId).not.toBeNull();
    await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${lone}` });
    const onPerson = await as(p.token, 'POST', '/me/mobile/verify', {
      mobile: `0${lone}`,
      code: h.sms.lastCodeFor(lone),
    });
    expect(onPerson.status).toBe(409);
    expect(onPerson.body['error']).toBe('mobile_taken');

    expect(await accountMobile(p.accountId)).toBe(p.mobile);
    expect(await accountMobile(holder.accountId)).toBe(holder.mobile);
    expect((await mobilesOf(p.personId ?? '')).map((m) => [m.mobile, m.deleted])).toEqual([
      [p.mobile, false],
    ]);
    const notices = await h.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM factor_change_notices WHERE account_id = $1`,
      [p.accountId],
    );
    expect(notices.rows[0]?.n).toBe(0);
  });

  it('limits codes per account, and locks a mobile after wrong codes', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    // identity.otp sendsPerMobilePerHour (8) is also the limit per account, across mobiles.
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      statuses.push(
        (await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${newMobile()}` })).status,
      );
    }
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(202));
    expect(statuses[8]).toBe(429);

    const q = await patient();
    const to = newMobile();
    await as(q.token, 'POST', '/me/mobile/request', { mobile: `0${to}` });
    const code = h.sms.lastCodeFor(to);
    const bad = code === '000000' ? '111111' : '000000';
    const tries: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      tries.push(
        (await as(q.token, 'POST', '/me/mobile/verify', { mobile: `0${to}`, code: bad })).status,
      );
    }
    // failuresBeforeLock (6): the sixth wrong code locks; the right one no longer works.
    expect(tries.slice(0, 5)).toEqual(Array(5).fill(401));
    expect(tries[5]).toBe(429);
    expect(
      (await as(q.token, 'POST', '/me/mobile/verify', { mobile: `0${to}`, code })).status,
    ).toBe(429);
    expect(await accountMobile(q.accountId)).toBe(q.mobile);
  });

  it('needs an active login, and waits between changes', async () => {
    const p = await patient();
    const { rows } = await h.owner.query<{ id: string; authenticated_at: Date }>(
      `SELECT id, authenticated_at FROM sessions
        WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [p.accountId],
    );
    const session = rows[0];
    if (!session) throw new Error('no session');
    const auth: AuthContext = {
      accountId: p.accountId,
      sessionId: session.id,
      client: 'mobile',
      kind: 'patient',
      stage: 'active',
      authenticatedAt: session.authenticated_at,
      reauthenticatedAt: null,
      mobileVerified: true,
    };
    const actor: Actor = { accountId: p.accountId, sessionId: session.id, ip: null, roles: [] };
    const real = h.app.get<ConfigPort>(CONFIG);
    const service = (value: typeof ON) =>
      new PatientMobileService(
        db,
        h.app.get<AuditLog>(AUDIT_LOG),
        {
          ...real,
          resolve: async (key: string, ctx: unknown, now?: Date) =>
            key === 'identity.patient_mobile_change'
              ? { ...(await real.resolve('identity.patient_mobile_change', {}, now)), value }
              : real.resolve(key as never, ctx as never, now),
        } as unknown as ConfigPort,
        h.app.get<Redis>(REDIS),
        h.app.get(OtpChallengeService),
        h.app.get(FactorNotices),
        h.app.get<PersonMobileChange>(PERSON_MOBILE_CHANGE),
      );
    const signedIn = session.authenticated_at.getTime();

    // Signed in more than recentLoginSeconds ago: sign in again first.
    await expect(
      service(ON).request(actor, auth, newMobile(), new Date(signedIn + 601_000)),
    ).rejects.toMatchObject({ response: { error: 'recent_login_required' } });
    await expect(
      service(ON).request(actor, auth, newMobile(), new Date(signedIn + 599_000)),
    ).resolves.toMatchObject({ expiresInSeconds: expect.any(Number) as unknown });

    // One change, then a wait of cooldownDays before the next.
    const to = newMobile();
    const live = service(ON);
    const now = new Date(signedIn + 1_000);
    await live.request(actor, auth, to, now);
    await live.verify(actor, auth, to, h.sms.lastCodeFor(to), now);
    const wait = { enabled: true, recentLoginSeconds: 10 * 86_400, cooldownDays: 2 };
    await expect(
      service(wait).request(actor, auth, newMobile(), new Date(Date.now() + 86_400_000)),
    ).rejects.toMatchObject({ response: { error: 'mobile_change_too_soon' } });
    await expect(
      service(wait).request(actor, auth, newMobile(), new Date(Date.now() + 3 * 86_400_000)),
    ).resolves.toMatchObject({ expiresInSeconds: expect.any(Number) as unknown });
  });
});
