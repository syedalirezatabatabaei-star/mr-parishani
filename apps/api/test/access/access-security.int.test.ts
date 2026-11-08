import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createNode,
  grantRole,
  loggedInAccount,
  newAccount,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * Security of the roles page and its API (owner 1405/07/24, round seventeen): IDOR, roles
 * that may not, two people for offboarding held by the server, an audit row for every change
 * with its actor, and no patient data in any answer.
 */

type Row = Record<string, unknown>;

let h: Harness;
/** System admins: hold every access.* and both offboarding permissions. */
let admin: LoggedInAccount;
let admin2: LoggedInAccount;
/** Holds both offboarding permissions, no access.* ones. */
let ceo: LoggedInAccount;
/** No access.* and no offboarding permission. */
let accounting: LoggedInAccount;
let doctorA: LoggedInAccount;
let doctorB: LoggedInAccount;
const tree = { center: '', doctorA: '', doctorB: '', secretaryA: '', secretaryB: '' };
let secretaryB: { id: string; username: string };

const as = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

/** Audit rows of `action` on `entityId`, by `actor`. */
const audited = async (action: string, entityId: string, actor: string) =>
  (
    await h.owner.query<Row>(
      `SELECT before, after, reason FROM audit_events
        WHERE action = $1 AND entity_id = $2 AND actor_account_id = $3`,
      [action, entityId, actor],
    )
  ).rows;

/** A patient account, with a username set, as if one leaked in. */
async function patient(): Promise<{ id: string; username: string; mobile: string }> {
  const mobile = newMobile();
  expect((await otpLogin(h, mobile, 'mobile')).status).toBe(200);
  const username = `patient_${mobile}`;
  const { rows } = await h.owner.query<Row>(
    'UPDATE user_accounts SET username = $1 WHERE mobile = $2 RETURNING id',
    [username, mobile],
  );
  return { id: rows[0]?.['id'] as string, username, mobile };
}

/** No answer of these routes carries a mobile, a national ID or the treatment. */
function noPatientData(body: unknown, mobile?: string) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/"(mobile|mobiles|nationalId|national_id|treatment\w*)"/i);
  if (mobile) expect(text).not.toContain(mobile);
}

beforeAll(async () => {
  h = await startHarness();
  [admin, admin2, ceo, accounting, doctorA, doctorB] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'center'),
    loggedInAccount(h, 'center'),
  ]);
  await grantRole(h, admin.id, 'system_admin');
  await grantRole(h, admin2.id, 'system_admin');
  await grantRole(h, ceo.id, 'ceo');
  await grantRole(h, accounting.id, 'accounting');
  const secretaryA = await newAccount(h, 'center');
  secretaryB = await newAccount(h, 'center');
  tree.center = await createNode(h, 'center');
  tree.doctorA = await createNode(h, 'doctor', { parentId: tree.center, accountId: doctorA.id });
  tree.doctorB = await createNode(h, 'doctor', { parentId: tree.center, accountId: doctorB.id });
  tree.secretaryA = await createNode(h, 'secretary', {
    parentId: tree.doctorA,
    accountId: secretaryA.id,
  });
  tree.secretaryB = await createNode(h, 'secretary', {
    parentId: tree.doctorB,
    accountId: secretaryB.id,
  });
  await grantRole(h, doctorA.id, 'doctor', { kind: 'doctor', nodeId: tree.doctorA });
  await grantRole(h, doctorB.id, 'doctor', { kind: 'doctor', nodeId: tree.doctorB });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('roles page security: roles that may not (403), whatever the id', () => {
  it('each route refuses a role without its permission', async () => {
    const staff = await newAccount(h, 'staff');
    const refused: [LoggedInAccount, string, string, unknown?][] = [
      [accounting, 'GET', '/access/roles'],
      [accounting, 'GET', '/access/permissions'],
      [
        accounting,
        'POST',
        '/access/roles',
        { code: 'x_role', name: 'نقش', permissions: [], reason: 'آزمون' },
      ],
      [accounting, 'GET', `/access/accounts/${staff.id}/assignments`],
      [accounting, 'GET', `/access/accounts/by-username/${staff.username}`],
      [
        accounting,
        'POST',
        '/access/assignments',
        { accountId: staff.id, roleCode: 'support', scope: { kind: 'global' }, reason: 'آزمون' },
      ],
      [accounting, 'GET', '/identity/staff-offboardings'],
      [
        accounting,
        'POST',
        '/identity/staff-offboardings',
        { targetAccountId: staff.id, reason: 'آزمون' },
      ],
      // The CEO offboards, but neither reads nor grants roles.
      [ceo, 'GET', '/access/roles'],
      [ceo, 'GET', `/access/accounts/${staff.id}/assignments`],
      [
        ceo,
        'POST',
        '/access/assignments',
        { accountId: staff.id, roleCode: 'support', scope: { kind: 'global' }, reason: 'آزمون' },
      ],
      // A doctor, center side: nothing of the internal roles page.
      [doctorA, 'GET', '/access/roles'],
      [doctorA, 'GET', `/access/accounts/by-username/${staff.username}`],
      [doctorA, 'GET', '/identity/staff-offboardings'],
    ];
    for (const [who, method, path, body] of refused) {
      const res = await as(who, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // Nothing was granted to the account by any of it.
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM role_assignments WHERE account_id = $1',
      [staff.id],
    );
    expect(rows[0]?.['n']).toBe(0);
  });

  it("IDOR: a doctor grants nothing on another doctor's secretary, by guessing the node id", async () => {
    const res = await as(doctorA, 'POST', `/access/org-nodes/${tree.secretaryB}/assignments`, {
      roleCode: 'secretary',
      reason: 'منشی دیگری',
    });
    expect(res.status).toBe(404);
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM role_assignments WHERE account_id = $1',
      [secretaryB.id],
    );
    expect(rows[0]?.['n']).toBe(0);
    // Its own secretary: allowed.
    const own = await as(doctorA, 'POST', `/access/org-nodes/${tree.secretaryA}/assignments`, {
      roleCode: 'secretary',
      reason: 'منشی خودم',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
  });

  it('nobody grants roles to themselves, nor edits a system role', async () => {
    const self = await as(admin, 'POST', '/access/assignments', {
      accountId: admin.id,
      roleCode: 'ceo',
      scope: { kind: 'global' },
      reason: 'به خودم',
    });
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('cannot_assign_own_roles');
    const roles = (await as(admin, 'GET', '/access/roles')).body as unknown as Row[];
    const system = roles.find((r) => r['code'] === 'support');
    const locked = await as(admin, 'PUT', `/access/roles/${String(system?.['id'])}/permissions`, {
      permissions: ['access.manage_roles'],
      reason: 'بالا بردن پشتیبانی',
    });
    expect(locked.status).toBe(409);
    expect(locked.body['error']).toBe('system_role_locked');
  });
});

describe('roles page security: two people for offboarding, held by the server', () => {
  it('never the asker, never the target; the second person decides', async () => {
    const leaving = await newAccount(h, 'staff');
    const asked = await as(ceo, 'POST', '/identity/staff-offboardings', {
      targetAccountId: leaving.id,
      reason: 'خروج کارمند، آزمون امنیت',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = String(asked.body['id']);
    const own = await as(ceo, 'POST', `/identity/staff-offboardings/${id}/approve`);
    expect(own.status).toBe(403);
    expect(own.body['error']).toBe('second_person_required');
    const ownReject = await as(ceo, 'POST', `/identity/staff-offboardings/${id}/reject`);
    expect(ownReject.status).toBe(403);
    const { rows } = await h.owner.query<Row>('SELECT status FROM user_accounts WHERE id = $1', [
      leaving.id,
    ]);
    expect(rows[0]?.['status']).toBe('active');

    // The target, though holding the approval, does not decide on themselves.
    const target = await as(ceo, 'POST', '/identity/staff-offboardings', {
      targetAccountId: admin2.id,
      reason: 'خروج مدیر سیستم، آزمون',
    });
    expect(target.status).toBe(201);
    const self = await as(
      admin2,
      'POST',
      `/identity/staff-offboardings/${String(target.body['id'])}/approve`,
    );
    expect(self.status).toBe(403);
    expect(
      (await as(admin, 'POST', `/identity/staff-offboardings/${String(target.body['id'])}/reject`))
        .status,
    ).toBe(201);

    // Nobody asks to offboard themselves.
    const selfAsk = await as(ceo, 'POST', '/identity/staff-offboardings', {
      targetAccountId: ceo.id,
      reason: 'خروج خودم',
    });
    expect(selfAsk.status).toBe(403);

    const done = await as(admin, 'POST', `/identity/staff-offboardings/${id}/approve`);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(
      (await h.owner.query<Row>('SELECT status FROM user_accounts WHERE id = $1', [leaving.id]))
        .rows[0]?.['status'],
    ).toBe('disabled');
  });
});

describe('roles page security: an audit row for every change, with its actor', () => {
  it('role made, permissions changed, granted, revoked, offboarding asked and decided', async () => {
    const code = `sec_${String(Date.now()).slice(-8)}`;
    const made = await as(admin, 'POST', '/access/roles', {
      code,
      name: 'نقش آزمون امنیت',
      permissions: ['access.read_roles'],
      reason: 'ساخت نقش آزمون',
    });
    expect(made.status).toBe(201);
    const roleId = String(made.body['id']);
    expect(await audited('access.role_created', roleId, admin.id)).toEqual([
      expect.objectContaining({ reason: 'ساخت نقش آزمون' }),
    ]);

    expect(
      (
        await as(admin, 'PUT', `/access/roles/${roleId}/permissions`, {
          permissions: ['access.read_roles', 'audit.read'],
          reason: 'افزودن خواندن سابقه',
        })
      ).status,
    ).toBe(204);
    expect(await audited('access.role_permissions_changed', roleId, admin.id)).toEqual([
      expect.objectContaining({
        before: { permissions: ['access.read_roles'] },
        after: { permissions: ['access.read_roles', 'audit.read'] },
        reason: 'افزودن خواندن سابقه',
      }),
    ]);

    const staff = await newAccount(h, 'staff');
    const granted = await as(admin, 'POST', '/access/assignments', {
      accountId: staff.id,
      roleCode: code,
      scope: { kind: 'global' },
      reason: 'دادن نقش آزمون',
    });
    expect(granted.status).toBe(201);
    expect(await audited('access.role_assigned', staff.id, admin.id)).toEqual([
      expect.objectContaining({ reason: 'دادن نقش آزمون' }),
    ]);
    expect(
      (
        await as(admin2, 'POST', `/access/assignments/${String(granted.body['id'])}/revoke`, {
          reason: 'لغو نقش آزمون',
        })
      ).status,
    ).toBe(204);
    expect(await audited('access.role_revoked', staff.id, admin2.id)).toEqual([
      expect.objectContaining({ reason: 'لغو نقش آزمون' }),
    ]);

    const asked = await as(ceo, 'POST', '/identity/staff-offboardings', {
      targetAccountId: staff.id,
      reason: 'خروج، آزمون سابقه',
    });
    expect(await audited('identity.staff_offboarding_requested', staff.id, ceo.id)).toHaveLength(1);
    await as(admin, 'POST', `/identity/staff-offboardings/${String(asked.body['id'])}/approve`);
    expect(await audited('identity.staff_offboarded', staff.id, admin.id)).toEqual([
      expect.objectContaining({ before: { status: 'active' } }),
    ]);
  });
});

describe('roles page security: no patient data in any answer', () => {
  it('a patient is not found, has no roles, is not offboarded; no answer carries personal data', async () => {
    const p = await patient();
    const lookup = await as(admin, 'GET', `/access/accounts/by-username/${p.username}`);
    expect(lookup.status).toBe(404);
    noPatientData(lookup.body, p.mobile);
    const assignments = await as(admin, 'GET', `/access/accounts/${p.id}/assignments`);
    expect(assignments.status).toBe(200);
    expect(assignments.body).toEqual([]);
    const grant = await as(admin, 'POST', '/access/assignments', {
      accountId: p.id,
      roleCode: 'support',
      scope: { kind: 'global' },
      reason: 'نقش برای بیمار',
    });
    expect(grant.status).toBe(400);
    expect(grant.body['error']).toBe('patient_account');
    const off = await as(ceo, 'POST', '/identity/staff-offboardings', {
      targetAccountId: p.id,
      reason: 'خروج بیمار',
    });
    expect(off.status).toBe(404);
    noPatientData(off.body, p.mobile);

    const staff = await newAccount(h, 'center');
    for (const path of [
      '/access/roles',
      '/access/permissions',
      `/access/accounts/by-username/${staff.username}`,
      `/access/accounts/${staff.id}/assignments`,
      '/identity/staff-offboardings',
    ]) {
      const res = await as(admin, 'GET', path);
      expect(res.status, path).toBe(200);
      noPatientData(res.body);
    }
  });
});
