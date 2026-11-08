import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { AccessService } from '../../src/modules/access/access.service';
import {
  call,
  grantRole,
  loggedInAccount,
  newIp,
  newMobile,
  otpLogin,
  STAFF_PASSWORD,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from './harness';

/**
 * Offboarding a staff or center account (owner 1405/07/23, plan 4; migration 0087): asked by
 * one person, approved or rejected by another, never the asker nor the target. Approved, the
 * account is disabled, every role revoked and every session ended, each audited; nothing is
 * deleted. The database holds the two-person rule and a decision is final.
 */

type Row = Record<string, unknown>;

let h: Harness;
let asker: LoggedInAccount;
let approver: LoggedInAccount;
/** Holds both permissions: may ask and decide, never their own request. */
let both: LoggedInAccount;
let nobody: LoggedInAccount;

const as = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });
const ask = (who: LoggedInAccount, targetAccountId: string, reason = 'پایان همکاری') =>
  as(who, 'POST', '/identity/staff-offboardings', { targetAccountId, reason });
const decide = (who: LoggedInAccount, id: string, decision: 'approve' | 'reject') =>
  as(who, 'POST', `/identity/staff-offboardings/${id}/${decision}`);

async function role(permissions: string[]) {
  const code = `off_${Math.random().toString(36).slice(2, 10)}`;
  await h.app.get(AccessService).createRole(CLI_ACTOR, {
    code,
    name: 'خروج کارمند',
    permissions: permissions as never,
    reason: 'test fixture',
  });
  return code;
}

/** A staff member with a role and a live session: who leaves. */
async function leaver() {
  const who = await loggedInAccount(h, 'staff');
  await grantRole(h, who.id, 'accounting');
  await grantRole(h, who.id, 'case_completion');
  expect((await as(who, 'GET', '/auth/me')).status).toBe(200);
  return who;
}

const audits = async (accountId: string, action: string) =>
  (
    await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = $2`,
      [accountId, action],
    )
  ).rows[0]?.['n'];

beforeAll(async () => {
  h = await startHarness();
  const askRole = await role(['identity.request_staff_offboarding']);
  const approveRole = await role(['identity.approve_staff_offboarding']);
  const bothRole = await role([
    'identity.request_staff_offboarding',
    'identity.approve_staff_offboarding',
  ]);
  asker = await loggedInAccount(h);
  approver = await loggedInAccount(h);
  both = await loggedInAccount(h);
  nobody = await loggedInAccount(h);
  await grantRole(h, asker.id, askRole);
  await grantRole(h, approver.id, approveRole);
  await grantRole(h, both.id, bothRole);
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('offboarding a staff member (owner 1405/07/23, plan 4)', () => {
  it('approved by a second person: disabled, every role revoked, every session ended, audited', async () => {
    const target = await leaver();
    const asked = await ask(asker, target.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({
      status: 'pending',
      requestedByMe: true,
      rolesRevoked: null,
    });
    const id = asked.body['id'] as string;
    // Still working while it waits.
    expect((await as(target, 'GET', '/auth/me')).status).toBe(200);
    expect((await ask(asker, target.id)).body['error']).toBe('request_open');

    const listed = await as(approver, 'GET', '/identity/staff-offboardings');
    expect(listed.status).toBe(200);
    expect(listed.body as unknown as Row[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, requestedByMe: false })]),
    );

    const done = await decide(approver, id, 'approve');
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ status: 'approved', rolesRevoked: 2 });

    // The open session is over, and a new login is refused.
    expect((await as(target, 'GET', '/auth/me')).status).toBe(401);
    const login = await call(h, 'POST', '/auth/staff/login', {
      ip: newIp(),
      body: { username: target.username, password: STAFF_PASSWORD, client: 'mobile' },
    });
    expect(login.status).toBe(403);
    expect(login.body['error']).toBe('account_disabled');

    // Nothing deleted: the account is there, disabled; its roles revoked, its sessions too.
    const { rows } = await h.owner.query<Row>(
      `SELECT a.status, a.deleted_at,
              (SELECT count(*)::int FROM role_assignments r
                WHERE r.account_id = a.id AND r.revoked_at IS NULL) AS live_roles,
              (SELECT count(*)::int FROM sessions s
                WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS live_sessions,
              (SELECT count(*)::int FROM sessions s
                WHERE s.account_id = a.id AND s.revoke_reason = 'offboarded') AS ended
       FROM user_accounts a WHERE a.id = $1`,
      [target.id],
    );
    expect(rows[0]).toMatchObject({ status: 'disabled', deleted_at: null, live_roles: 0 });
    expect(rows[0]?.['live_sessions']).toBe(0);
    expect(Number(rows[0]?.['ended'])).toBeGreaterThan(0);
    expect(await audits(target.id, 'identity.staff_offboarding_requested')).toBe(1);
    expect(await audits(target.id, 'identity.staff_offboarded')).toBe(1);
    expect(await audits(target.id, 'access.role_revoked')).toBe(2);

    // Decided once; a disabled account is not asked again.
    expect((await decide(approver, id, 'approve')).body['error']).toBe('already_decided');
    expect((await ask(asker, target.id)).body['error']).toBe('already_offboarded');
  });

  it('rejected by a second person: nothing changes', async () => {
    const target = await leaver();
    const id = (await ask(asker, target.id)).body['id'] as string;
    const rejected = await decide(approver, id, 'reject');
    expect(rejected.status).toBe(201);
    expect(rejected.body).toMatchObject({ status: 'rejected', rolesRevoked: null });
    expect((await as(target, 'GET', '/auth/me')).status).toBe(200);
    const { rows } = await h.owner.query<Row>(`SELECT status FROM user_accounts WHERE id = $1`, [
      target.id,
    ]);
    expect(rows[0]?.['status']).toBe('active');
    expect(await audits(target.id, 'identity.staff_offboarding_rejected')).toBe(1);
    expect(await audits(target.id, 'access.role_revoked')).toBe(0);
  });

  it('two people: never the asker, never the target, never oneself; staff only; by permission', async () => {
    const target = await leaver();
    // The asker never decides their own request, even holding both permissions.
    const own = await ask(both, target.id);
    expect(own.status).toBe(201);
    const self = await decide(both, own.body['id'] as string, 'approve');
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('second_person_required');
    expect((await decide(both, own.body['id'] as string, 'reject')).status).toBe(403);
    expect((await as(target, 'GET', '/auth/me')).status).toBe(200);
    // The target never decides their own offboarding.
    const target2 = await leaver();
    const theirs = await ask(asker, both.id);
    expect(theirs.status).toBe(201);
    const byTarget = await decide(both, theirs.body['id'] as string, 'approve');
    expect(byTarget.body['error']).toBe('second_person_required');
    expect((await decide(approver, theirs.body['id'] as string, 'reject')).status).toBe(201);

    // Nobody offboards themselves; a patient is no staff member.
    expect((await ask(both, both.id)).body['error']).toBe('cannot_offboard_self');
    const mobile = newMobile();
    expect((await otpLogin(h, mobile, 'mobile', { ip: newIp() })).status).toBe(200);
    const patient = await h.owner.query<Row>('SELECT id FROM user_accounts WHERE mobile = $1', [
      mobile,
    ]);
    expect((await ask(asker, patient.rows[0]?.['id'] as string)).status).toBe(404);

    // Without the permission: 403 to ask, to list and to decide.
    expect((await ask(nobody, target2.id)).status).toBe(403);
    expect((await as(nobody, 'GET', '/identity/staff-offboardings')).status).toBe(403);
    expect((await decide(asker, own.body['id'] as string, 'approve')).status).toBe(403);
  });

  it('the database holds the rule: no request of oneself, no decision by the asker, a decision is final', async () => {
    const target = await leaver();
    await expect(
      h.owner.query(
        `INSERT INTO staff_offboarding_requests (target_account_id, requested_by, reason)
         VALUES ($1, $1, 'خودم')`,
        [target.id],
      ),
    ).rejects.toThrow(/two_people_check/);
    const { rows } = await h.owner.query<Row>(
      `INSERT INTO staff_offboarding_requests (target_account_id, requested_by, reason)
       VALUES ($1, $2, 'آزمون پایگاه') RETURNING id`,
      [target.id, asker.id],
    );
    const id = rows[0]?.['id'] as string;
    await expect(
      h.owner.query(
        `UPDATE staff_offboarding_requests SET status = 'rejected', decided_by = $2,
           decided_at = now() WHERE id = $1`,
        [id, asker.id],
      ),
    ).rejects.toThrow(/two_people_check/);
    await h.owner.query(
      `UPDATE staff_offboarding_requests SET status = 'rejected', decided_by = $2,
         decided_at = now() WHERE id = $1`,
      [id, approver.id],
    );
    await expect(
      h.owner.query(`UPDATE staff_offboarding_requests SET status = 'approved' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/a decided request does not change/);
  });

  it('needs a TOTP code given again in the session when identity.reauth is on (R1)', async () => {
    const target = await leaver();
    const id = (await ask(asker, target.id)).body['id'] as string;
    const at = new Date();
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('identity.reauth', 'global', $1::jsonb, $2, 'approved', 'test', $2)`,
      [JSON.stringify({ enabled: true, windowSeconds: 300 }), at],
    );
    try {
      const refused = await decide(approver, id, 'approve');
      expect(refused.status).toBe(403);
      expect(refused.body['error']).toBe('reauth_required');
      expect((await as(target, 'GET', '/auth/me')).status).toBe(200);
    } finally {
      await h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('identity.reauth', 'global', $1::jsonb, now(), 'approved', 'test', now())`,
        [JSON.stringify({ enabled: false, windowSeconds: 300 })],
      );
    }
  });
});
