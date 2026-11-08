import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { FirstApproverMobile } from '../../src/modules/identity/first-approver-mobile';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOBILE_EXEMPT_METADATA } from '../../src/common/auth/auth.decorators';
import {
  call,
  grantRole,
  loggedInAccount,
  newMobile,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from './harness';

/**
 * Owner, question 3 of task 9-3: an internal staff member proves a mobile before anything
 * else, through the form the panel requires at the next sign-in. Until then the API answers
 * only the mobile's own endpoints, logging out and `me` (which tells the panel to ask);
 * everything else, their own sessions and password included, is 403 `mobile_required`.
 * Nothing is locked, and everything opens the moment the mobile is proved. Center accounts
 * keep task 4-6's rule.
 */

let h: Harness;

const as = (a: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: a.access, ...(body === undefined ? {} : { body }) });

const setRequired = (enabled: boolean) =>
  h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('identity.staff_mobile_required', 'global', $1::jsonb, $2, 'approved', 'test', $2)`,
    [JSON.stringify({ enabled }), new Date()],
  );

beforeAll(async () => {
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await setRequired(false);
  await h.close();
});

describe('a staff member without a proved mobile', () => {
  it('reaches only their own account until they prove one; then everything again', async () => {
    const staff = await loggedInAccount(h, 'staff');
    await grantRole(h, staff.id, 'system_admin');
    await setRequired(true);

    const me = await as(staff, 'GET', '/auth/me');
    expect(me.status).toBe(200);
    expect(me.body['mobileRequired']).toBe(true);
    // Everything but the mobile, logging out and `me`: a permission endpoint, and their own
    // permissions, sessions, password and re-authentication too.
    for (const [method, path, body] of [
      ['GET', '/access/roles'],
      ['GET', '/access/me'],
      ['GET', '/auth/sessions'],
      ['POST', '/auth/password', { currentPassword: 'x', newPassword: 'y' }],
      ['POST', '/auth/totp/reauth', { code: '123456' }],
    ] as const) {
      const refused = await as(staff, method, path, body);
      expect(refused.status, path).toBe(403);
      expect(refused.body, path).toMatchObject({ error: 'mobile_required' });
    }
    expect((await as(staff, 'GET', '/auth/mobile')).status).toBe(200);
    // Not locked or disabled.
    const { rows } = await h.owner.query<{ status: string }>(
      'SELECT status FROM user_accounts WHERE id = $1',
      [staff.id],
    );
    expect(rows[0]?.status).toBe('active');

    // ADR-052 (owner 1405/08/03): an administrator is a financial signer; their first number is
    // not proved on the self-service page but set on the server, the owner present.
    const mobile = newMobile();
    const self = await as(staff, 'POST', '/auth/mobile/request', { mobile });
    expect([self.status, self.body['error']]).toEqual([409, 'signer_mobile_needs_approval']);
    const { rows: named } = await h.owner.query<{ username: string }>(
      'SELECT username FROM user_accounts WHERE id = $1',
      [staff.id],
    );
    await h.app.get(FirstApproverMobile).set({
      username: named[0]?.username ?? '',
      mobile: `0${mobile}`,
      // The administrator runs it for their own number; another staff member witnesses.
      operator: named[0]?.username ?? '',
      witness: await (async () => {
        const watcher = await loggedInAccount(h, 'staff');
        const { rows } = await h.owner.query<{ username: string }>(
          'SELECT username FROM user_accounts WHERE id = $1',
          [watcher.id],
        );
        return rows[0]?.username ?? '';
      })(),
      reason: 'شماره اول مدیر سیستم',
    });

    expect((await as(staff, 'GET', '/auth/me')).body['mobileRequired']).toBe(false);
    expect((await as(staff, 'GET', '/access/roles')).status).toBe(200);
    expect((await as(staff, 'GET', '/auth/sessions')).status).toBe(200);
  });

  it('can still log out', async () => {
    const staff = await loggedInAccount(h, 'staff');
    await setRequired(true);
    expect((await as(staff, 'POST', '/auth/logout-all')).status).toBe(200);
    expect((await as(staff, 'GET', '/auth/me')).status).toBe(401);
  });

  it('the endpoints reachable before the mobile is proved are exactly these', () => {
    const discovery = h.app.get(DiscoveryService);
    const scanner = h.app.get(MetadataScanner);
    const reflector = h.app.get(Reflector);
    const exempt: string[] = [];
    for (const wrapper of discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) continue;
      const controller = instance.constructor as new (...args: never[]) => unknown;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        if (reflector.getAllAndOverride<boolean>(MOBILE_EXEMPT_METADATA, [handler, controller])) {
          exempt.push(`${controller.name}.${name}`);
        }
      }
    }
    expect(exempt.sort()).toEqual([
      'AccountMobileController.request',
      'AccountMobileController.verify',
      'AccountMobileController.view',
      'AuthController.logout',
      'AuthController.logoutAll',
      'AuthController.me',
    ]);
  });

  it('is not asked while the flag is off (until go-live)', async () => {
    const staff = await loggedInAccount(h, 'staff');
    await grantRole(h, staff.id, 'system_admin');
    await setRequired(false);
    expect((await as(staff, 'GET', '/auth/me')).body['mobileRequired']).toBe(false);
    expect((await as(staff, 'GET', '/access/roles')).status).toBe(200);
  });

  it('a center account is not held by it (task 4-6 keeps its own rule)', async () => {
    const center = await loggedInAccount(h, 'center');
    await h.owner.query(
      'UPDATE user_accounts SET mobile = NULL, mobile_verified_at = NULL WHERE id = $1',
      [center.id],
    );
    await setRequired(true);
    expect((await as(center, 'GET', '/auth/me')).body['mobileRequired']).toBe(false);
    const res = await as(center, 'GET', '/access/org-nodes');
    expect(res.body['error']).not.toBe('mobile_required');
  });
});
