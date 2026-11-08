import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
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
 * The roles page (owner 1405/07/24, م۱۰): finding a staff or center account by username to
 * grant, revoke or offboard it, and the typed answers the page reads (the harness checks each
 * answer against its @ZodResponse).
 */

let h: Harness;
let admin: LoggedInAccount;
let ceo: LoggedInAccount;
let accounting: LoggedInAccount;

const get = (who: LoggedInAccount, path: string) => call(h, 'GET', path, { bearer: who.access });

beforeAll(async () => {
  h = await startHarness();
  [admin, ceo, accounting] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, admin.id, 'system_admin');
  await grantRole(h, ceo.id, 'ceo');
  await grantRole(h, accounting.id, 'accounting');
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('the roles page: an account by username (owner 1405/07/24)', () => {
  it('finds a staff or center account, as typed at login; never a patient; by permission', async () => {
    const staff = await newAccount(h, 'staff');
    const center = await newAccount(h, 'center');

    const found = await get(admin, `/access/accounts/by-username/${staff.username.toUpperCase()}`);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body).toEqual({
      id: staff.id,
      username: staff.username,
      displayName: null,
      kind: 'staff',
      status: 'active',
    });
    // No mobile, nothing else of the account.
    expect(Object.keys(found.body).sort()).toEqual([
      'displayName',
      'id',
      'kind',
      'status',
      'username',
    ]);
    expect(
      (await get(admin, `/access/accounts/by-username/${center.username}`)).body,
    ).toMatchObject({ id: center.id, kind: 'center' });

    // The offboarding requester finds it too.
    expect((await get(ceo, `/access/accounts/by-username/${staff.username}`)).status).toBe(200);

    // Unknown, or a patient given a username: not found.
    expect((await get(admin, '/access/accounts/by-username/nobody_here')).body).toMatchObject({
      error: 'account_not_found',
    });
    const mobile = newMobile();
    expect((await otpLogin(h, mobile, 'mobile')).status).toBe(200);
    await h.owner.query('UPDATE user_accounts SET username = $1 WHERE mobile = $2', [
      'patient_with_name',
      mobile,
    ]);
    expect((await get(admin, '/access/accounts/by-username/patient_with_name')).status).toBe(404);

    // Without access.assign_roles or the offboarding request: refused.
    expect((await get(accounting, `/access/accounts/by-username/${staff.username}`)).status).toBe(
      403,
    );
  });

  it('an offboarding names its target by username, to who asks and to the second person', async () => {
    const leaving = await newAccount(h, 'staff');
    const asked = await call(h, 'POST', '/identity/staff-offboardings', {
      bearer: ceo.access,
      body: { targetAccountId: leaving.id, reason: 'خروج کارمند، آزمون' },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ targetUsername: leaving.username, requestedByMe: true });
    const listed = await get(admin, '/identity/staff-offboardings');
    expect(listed.status).toBe(200);
    expect(listed.body as unknown as unknown[]).toContainEqual(
      expect.objectContaining({
        id: asked.body['id'],
        targetUsername: leaving.username,
        requestedByMe: false,
      }),
    );
    const done = await call(
      h,
      'POST',
      `/identity/staff-offboardings/${String(asked.body['id'])}/approve`,
      {
        bearer: admin.access,
      },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ status: 'approved', targetUsername: leaving.username });
  });

  it('roles, assignments and grants answer in their typed shapes', async () => {
    const roles = await get(admin, '/access/roles');
    expect(roles.status).toBe(200);
    const list = roles.body as unknown as { code: string; isSystem: boolean }[];
    expect(list.find((r) => r.code === 'system_admin')).toMatchObject({ isSystem: true });

    const staff = await newAccount(h, 'staff');
    await grantRole(h, staff.id, 'accounting');
    const assignments = await get(admin, `/access/accounts/${staff.id}/assignments`);
    expect(assignments.status, JSON.stringify(assignments.body)).toBe(200);
    expect(assignments.body as unknown as unknown[]).toEqual([
      expect.objectContaining({ roleCode: 'accounting', scopeKind: 'global', scopeNodeId: null }),
    ]);
  });
});
