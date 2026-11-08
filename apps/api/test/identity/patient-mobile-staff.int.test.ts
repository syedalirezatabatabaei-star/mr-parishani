import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { DATABASE, type Database } from '../../src/db/database.module';
import { REDIS } from '../../src/infra/redis.module';
import { AccessService } from '../../src/modules/access/access.service';
import {
  call,
  grantRole,
  loggedInAccount,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from './harness';

/**
 * ف۱۲ ب۲ (owner 1405/07/26; migration 0091): a patient's previous mobile is lost, so staff
 * replace their login mobile, by two people as 0085. The first proposes with the code sent to
 * the new mobile and the evidence seen; a second, never the first, approves (the server and
 * the database); refusing takes one. Behind the flag `identity.patient_mobile_change`. The
 * last four digits only in every answer and audit.
 */

type Row = Record<string, unknown>;

let h: Harness;
let db: Database;
let first: LoggedInAccount;
let second: LoggedInAccount;
let nobody: LoggedInAccount;
let roleCode: string;

const ON = { enabled: true, recentLoginSeconds: 600, cooldownDays: 0 };

async function setConfig(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2::jsonb, $3, 'approved', 'آزمون', $3)`,
    [key, JSON.stringify(value), new Date()],
  );
}

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
  const { rows } = await h.owner.query<{ id: string; person_id: string | null }>(
    `SELECT id, person_id FROM user_accounts WHERE kind = 'patient' AND mobile = $1`,
    [mobile],
  );
  const row = rows[0];
  if (!row) throw new Error('no patient account');
  return {
    mobile,
    token: login.body['accessToken'] as string,
    accountId: row.id,
    personId: row.person_id ?? '',
  };
}

const as = (who: LoggedInAccount | string, method: string, path: string, body?: unknown) =>
  call(h, method, path, {
    bearer: typeof who === 'string' ? who : who.access,
    ...(body === undefined ? {} : { body }),
  });

const EVIDENCE = { reason: 'گوشی بیمار گم شده است', evidence: 'کارت ملی حضوری در شعبه' };

/** The code to the new mobile, then the proposal with it: the first of the two. */
async function propose(who: LoggedInAccount, currentMobile: string, newMobile_: string) {
  await clearCooldowns(newMobile_);
  const sent = await as(who, 'POST', '/identity/patient-mobile-changes/code', {
    currentMobile: `0${currentMobile}`,
    newMobile: `0${newMobile_}`,
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  return as(who, 'POST', '/identity/patient-mobile-changes', {
    currentMobile: `0${currentMobile}`,
    newMobile: `0${newMobile_}`,
    code: h.sms.lastCodeFor(newMobile_),
    ...EVIDENCE,
  });
}

const decide = (who: LoggedInAccount, id: string, decision: 'approve' | 'reject') =>
  as(who, 'POST', `/identity/patient-mobile-changes/${id}/${decision}`, {
    reason: decision === 'approve' ? 'مدرک دیده شد' : 'مدرک کافی نیست',
  });

const accountMobile = async (id: string) =>
  (await h.owner.query<{ mobile: string }>('SELECT mobile FROM user_accounts WHERE id = $1', [id]))
    .rows[0]?.mobile;

const requestsOf = async (accountId: string) =>
  (
    await h.owner.query<Row>(
      `SELECT status FROM patient_mobile_change_requests WHERE target_account_id = $1`,
      [accountId],
    )
  ).rows;

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'accepted';
  } catch (error) {
    const e = error as { message?: string; cause?: { message?: string } };
    return `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  }
};

beforeAll(async () => {
  h = await startHarness();
  db = h.app.get<Database>(DATABASE);
  roleCode = `pmc_${Math.random().toString(36).slice(2, 10)}`;
  await h.app.get(AccessService).createRole(CLI_ACTOR, {
    code: roleCode,
    name: 'تغییر شماره بیمار',
    permissions: ['identity.change_patient_mobile'],
    reason: 'test fixture',
  });
  first = await loggedInAccount(h);
  second = await loggedInAccount(h);
  nobody = await loggedInAccount(h);
  await grantRole(h, first.id, roleCode);
  await grantRole(h, second.id, roleCode);
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('a lost patient mobile replaced by staff, by two people (f12 ب2)', () => {
  it('is off until the flag is on; never without the permission, never for a patient', async () => {
    const p = await patient();
    const off = await as(first, 'POST', '/identity/patient-mobile-changes/code', {
      currentMobile: `0${p.mobile}`,
      newMobile: `0${newMobile()}`,
    });
    expect(off.status).toBe(403);
    expect(off.body['error']).toBe('feature_disabled');
    expect((await as(first, 'GET', '/identity/patient-mobile-changes')).status).toBe(403);
    await setConfig('identity.patient_mobile_change', ON);
    for (const who of [nobody.access, p.token]) {
      for (const [method, path] of [
        ['GET', '/identity/patient-mobile-changes'],
        ['POST', '/identity/patient-mobile-changes/code'],
        ['POST', '/identity/patient-mobile-changes'],
        ['POST', `/identity/patient-mobile-changes/${p.accountId}/approve`],
      ] as const) {
        expect((await as(who, method, path, method === 'GET' ? undefined : {})).status, path).toBe(
          403,
        );
      }
    }
  });

  it('the first proposes with the code; the second approves: the login, the Person, every session, the notice, the audit', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    // A second session, on the lost phone: ended too.
    await clearCooldowns(p.mobile);
    const lost = (await otpLogin(h, p.mobile, 'mobile')).body['accessToken'] as string;
    await h.owner.query(
      `INSERT INTO sms_consents (mobile, person_id, action, source) VALUES ($1, $2, 'consent', 'link')`,
      [p.mobile, p.personId],
    );
    const to = newMobile();

    // A wrong code proposes nothing.
    await clearCooldowns(to);
    await as(first, 'POST', '/identity/patient-mobile-changes/code', {
      currentMobile: `0${p.mobile}`,
      newMobile: `0${to}`,
    });
    const right = h.sms.lastCodeFor(to);
    const wrong = await as(first, 'POST', '/identity/patient-mobile-changes', {
      currentMobile: `0${p.mobile}`,
      newMobile: `0${to}`,
      code: right === '000000' ? '111111' : '000000',
      ...EVIDENCE,
    });
    expect(wrong.status).toBe(401);
    expect(await requestsOf(p.accountId)).toEqual([]);

    const proposed = await as(first, 'POST', '/identity/patient-mobile-changes', {
      currentMobile: `0${p.mobile}`,
      newMobile: `0${to}`,
      code: right,
      ...EVIDENCE,
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    expect(proposed.body).toMatchObject({
      accountId: p.accountId,
      fromLastFour: p.mobile.slice(-4),
      toLastFour: to.slice(-4),
      status: 'pending',
      requestedByMe: true,
      sessionsEnded: null,
    });
    const id = proposed.body['id'] as string;
    // Still the previous mobile while it waits; the patient still signed in.
    expect(await accountMobile(p.accountId)).toBe(p.mobile);
    expect((await as(p.token, 'GET', '/auth/me')).status).toBe(200);

    // The queue: the last four digits only.
    const listed = await as(second, 'GET', '/identity/patient-mobile-changes');
    expect(listed.status).toBe(200);
    expect(listed.body as unknown as Row[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, requestedByMe: false })]),
    );
    const json = JSON.stringify(listed.body);
    expect(json).not.toContain(p.mobile);
    expect(json).not.toContain(to);

    // The proposer does not approve their own.
    const self = await decide(first, id, 'approve');
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('proposed_by_same_account');
    expect(await accountMobile(p.accountId)).toBe(p.mobile);

    const done = await decide(second, id, 'approve');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'approved', requestedByMe: false, sessionsEnded: 2 });
    expect(JSON.stringify(done.body)).not.toContain(to);
    expect((await decide(second, id, 'approve')).body['error']).toBe('already_decided');

    // The login and the Person moved together; the previous row kept, soft-deleted.
    expect(await accountMobile(p.accountId)).toBe(to);
    const { rows: mobiles } = await h.owner.query<Row>(
      `SELECT mobile, status, added_via, deleted_at IS NOT NULL AS deleted, proved_at IS NOT NULL AS proved
         FROM person_mobiles WHERE person_id = $1 ORDER BY created_at, id`,
      [p.personId],
    );
    expect(mobiles).toEqual([
      expect.objectContaining({ mobile: p.mobile, deleted: true }),
      expect.objectContaining({
        mobile: to,
        status: 'active',
        added_via: 'mobile_change',
        deleted: false,
        proved: true,
      }),
    ]);
    // Every session ended: the lost phone's and the patient's.
    expect((await as(lost, 'GET', '/auth/me')).status).toBe(401);
    expect((await as(p.token, 'GET', '/auth/me')).status).toBe(401);
    // The previous mobile is told.
    const { rows: notices } = await h.owner.query<Row>(
      `SELECT mobile FROM factor_change_notices WHERE account_id = $1 AND event = 'patient_mobile_changed'`,
      [p.accountId],
    );
    expect(notices).toEqual([{ mobile: p.mobile }]);
    // Consent is not carried over.
    const { rows: consents } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM sms_consents WHERE mobile = $1`,
      [to],
    );
    expect(consents).toEqual([{ n: 0 }]);

    // The audit: two people, the last four digits only.
    const { rows: audits } = await h.owner.query<Row>(
      `SELECT action, actor_account_id, before, after, reason FROM audit_events
        WHERE entity_id = $1 AND action LIKE 'identity.patient_mobile_change%' ORDER BY created_at`,
      [p.accountId],
    );
    expect(audits.map((a) => a['action'])).toEqual([
      'identity.patient_mobile_change_proposed',
      'identity.patient_mobile_changed',
    ]);
    expect(audits[0]?.['actor_account_id']).toBe(first.id);
    expect(audits[1]).toMatchObject({
      actor_account_id: second.id,
      before: { mobileLastFour: p.mobile.slice(-4) },
      after: {
        mobileLastFour: to.slice(-4),
        method: 'staff',
        requestedBy: first.id,
        approvedBy: second.id,
        sessionsEnded: 2,
      },
    });
    const { rows: all } = await h.owner.query<{ j: string }>(
      `SELECT row_to_json(a)::text AS j FROM audit_events a WHERE entity_id = ANY($1::text[])`,
      [[p.accountId, p.personId]],
    );
    for (const a of all) {
      expect(a.j).not.toContain(p.mobile);
      expect(a.j).not.toContain(to);
    }

    // The new mobile opens the same account and Person; the lost one a new account of its own.
    await clearCooldowns(to);
    expect((await otpLogin(h, to, 'mobile')).status).toBe(200);
    const again = await h.owner.query<Row>(
      `SELECT id, person_id FROM user_accounts WHERE kind = 'patient' AND mobile = $1`,
      [to],
    );
    expect(again.rows).toEqual([{ id: p.accountId, person_id: p.personId }]);
    const thief = await patient(p.mobile);
    expect(thief.accountId).not.toBe(p.accountId);
    expect(thief.personId).not.toBe(p.personId);
  });

  it('not found, taken, open: refused, nothing changes (IDOR, no second request)', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    const other = await patient();
    const code = (currentMobile: string, newMobile_: string) =>
      as(first, 'POST', '/identity/patient-mobile-changes/code', {
        currentMobile: `0${currentMobile}`,
        newMobile: `0${newMobile_}`,
      });
    expect((await code(newMobile(), newMobile())).body['error']).toBe('patient_not_found');
    expect((await code(p.mobile, other.mobile)).body['error']).toBe('mobile_taken');
    expect((await code(p.mobile, p.mobile)).body['error']).toBe('same_mobile');
    // A request that is not there: 404, nothing told of it.
    const unknown = await as(
      second,
      'POST',
      '/identity/patient-mobile-changes/00000000-0000-7000-8000-000000000000/approve',
      { reason: 'مدرک دیده شد' },
    );
    expect(unknown.status).toBe(404);

    const to = newMobile();
    const made = await propose(first, p.mobile, to);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // One open request per account, and per new mobile.
    expect((await propose(second, p.mobile, newMobile())).body['error']).toBe('request_open');
    const third = await patient();
    expect((await propose(second, third.mobile, to)).body['error']).toBe('request_open');
    // The new mobile became another patient's meanwhile: approving is refused.
    await h.owner.query(`UPDATE user_accounts SET mobile = $1 WHERE id = $2`, [
      to,
      other.accountId,
    ]);
    const taken = await decide(second, made.body['id'] as string, 'approve');
    expect(taken.body['error']).toBe('mobile_taken');
    expect(await accountMobile(p.accountId)).toBe(p.mobile);
  });

  it("the account's mobile changed since the proposal: approving is refused (stale)", async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    const made = await propose(first, p.mobile, newMobile());
    const id = made.body['id'] as string;
    // The patient changed it themselves meanwhile (ب1).
    const own = newMobile();
    await clearCooldowns(own);
    await as(p.token, 'POST', '/me/mobile/request', { mobile: `0${own}` });
    const verified = await as(p.token, 'POST', '/me/mobile/verify', {
      mobile: `0${own}`,
      code: h.sms.lastCodeFor(own),
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    const stale = await decide(second, id, 'approve');
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toBe('patient_mobile_change_stale');
    expect(await accountMobile(p.accountId)).toBe(own);
    expect(await requestsOf(p.accountId)).toEqual([{ status: 'pending' }]);
  });

  it('refusing takes one, the proposer too; nothing changes; a decision is final', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    const made = await propose(first, p.mobile, newMobile());
    const id = made.body['id'] as string;
    const refused = await decide(first, id, 'reject');
    expect(refused.status, JSON.stringify(refused.body)).toBe(200);
    expect(refused.body).toMatchObject({ status: 'rejected', decisionReason: 'مدرک کافی نیست' });
    expect(await accountMobile(p.accountId)).toBe(p.mobile);
    expect((await as(p.token, 'GET', '/auth/me')).status).toBe(200);
    expect((await decide(second, id, 'approve')).body['error']).toBe('already_decided');
    const { rows } = await h.owner.query<Row>(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'identity.patient_mobile_change_rejected'`,
      [p.accountId],
    );
    expect(rows).toHaveLength(1);
    // Refused, another may be proposed.
    expect((await propose(first, p.mobile, newMobile())).status).toBe(201);
  });

  it('the database refuses it too: approved by the proposer, a decided request changed, a delete (sepehr_app)', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    const made = await propose(first, p.mobile, newMobile());
    const id = made.body['id'] as string;
    expect(
      await refusal(
        db.execute(sql`UPDATE patient_mobile_change_requests
          SET status = 'approved', decided_by = requested_by, decided_at = now(), decision_reason = 'خودش'
          WHERE id = ${id}`),
      ),
    ).toContain('patient_mobile_change_requests_two_people_check');
    expect(
      await refusal(
        db.execute(
          sql`UPDATE patient_mobile_change_requests SET to_mobile = ${newMobile()} WHERE id = ${id}`,
        ),
      ),
    ).toContain('who, which mobiles and why do not change');
    expect(
      await refusal(db.execute(sql`DELETE FROM patient_mobile_change_requests WHERE id = ${id}`)),
    ).toContain('permission denied');
    expect((await decide(second, id, 'reject')).status).toBe(200);
    expect(
      await refusal(
        db.execute(sql`UPDATE patient_mobile_change_requests SET status = 'pending', decided_by = NULL,
          decided_at = NULL, decision_reason = NULL WHERE id = ${id}`),
      ),
    ).toContain('a decided request does not change');
  });

  it('codes: the login code limits, and an hourly limit per staff account', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    const desk = await loggedInAccount(h);
    await grantRole(h, desk.id, roleCode);
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const res = await as(desk, 'POST', '/identity/patient-mobile-changes/code', {
        currentMobile: `0${p.mobile}`,
        newMobile: `0${newMobile()}`,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(202));
    expect(statuses[8]).toBe(429);
  });
});

describe('a request not decided within staffRequestDays expires (owner 1405/07/27, 0092)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A request proposed `days` ago: inserted as it was then (the guard only stops updates). */
  async function proposedAgo(p: { mobile: string; accountId: string }, days: number) {
    const to = newMobile();
    const { rows } = await h.owner.query<{ id: string }>(
      `INSERT INTO patient_mobile_change_requests
         (target_account_id, from_mobile, to_mobile, requested_by, reason, evidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        p.accountId,
        p.mobile,
        to,
        first.id,
        EVIDENCE.reason,
        EVIDENCE.evidence,
        new Date(Date.now() - days * DAY),
      ],
    );
    return { id: rows[0]?.id ?? '', to };
  }

  const stored = async (id: string) =>
    (
      await h.owner.query<Row>(
        `SELECT status, decided_by, decided_at, created_at FROM patient_mobile_change_requests WHERE id = $1`,
        [id],
      )
    ).rows[0];

  it('past 7 days: left out of the queue; deciding it records the expiry and answers 410; nothing changes', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    const old = await proposedAgo(p, 8);
    const fresh = await proposedAgo(await patient(), 6);
    const listed = await as(second, 'GET', '/identity/patient-mobile-changes');
    const ids = (listed.body as unknown as Row[]).map((r) => r['id']);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(old.id);

    const late = await decide(second, old.id, 'approve');
    expect(late.status).toBe(410);
    expect(late.body).toMatchObject({ error: 'request_expired' });
    const row = await stored(old.id);
    expect(row?.['status']).toBe('expired');
    expect(row?.['decided_by']).toBeNull();
    // Expired when its time ran out, not when someone looked.
    expect((row?.['decided_at'] as Date).getTime()).toBe(
      (row?.['created_at'] as Date).getTime() + 7 * DAY,
    );
    expect(await accountMobile(p.accountId)).toBe(p.mobile);
    const audits = await h.owner.query<Row>(
      `SELECT before, after FROM audit_events
        WHERE entity_id = $1 AND action = 'identity.patient_mobile_change_expired'`,
      [p.accountId],
    );
    expect(audits.rows).toHaveLength(1);
    expect(JSON.stringify(audits.rows)).not.toContain(old.to);
    expect(JSON.stringify(audits.rows)).toContain(old.to.slice(-4));
    // Final: refusing it now is refused the same way.
    expect((await decide(first, old.id, 'reject')).status).toBe(410);
    // Within the 7 days it is still decided as usual.
    expect((await decide(second, fresh.id, 'reject')).status).toBe(200);
  });

  it('an expired open request no longer holds the account: a new proposal expires it first', async () => {
    await setConfig('identity.patient_mobile_change', ON);
    const p = await patient();
    const open = await proposedAgo(p, 3);
    expect((await propose(first, p.mobile, newMobile())).status).toBe(409);
    const p2 = await patient();
    const old = await proposedAgo(p2, 8);
    const again = await propose(first, p2.mobile, newMobile());
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await stored(old.id))?.['status']).toBe('expired');
    expect((await stored(open.id))?.['status']).toBe('pending');
  });

  it('by the value in force when proposed (rule 16): 0 then means never, whatever today says', async () => {
    const p = await patient();
    // Before the request: 0 days (never). Today: the default, 7.
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('identity.patient_mobile_change', 'global', $1::jsonb, $2, 'approved', 'آزمون', $2)`,
      [JSON.stringify({ ...ON, staffRequestDays: 0 }), new Date(Date.now() - 30 * DAY)],
    );
    await setConfig('identity.patient_mobile_change', ON);
    const old = await proposedAgo(p, 20);
    const approved = await decide(second, old.id, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await accountMobile(p.accountId)).toBe(old.to);
  });
});
