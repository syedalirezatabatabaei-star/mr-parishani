import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { AccessService } from '../../src/modules/access/access.service';
import {
  call,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * Owner 1405/08/03 (0107): a technical setting is proposed by one role (the system
 * administrator: `config.propose_technical`) and decided by another (`technical_config_approver`:
 * `config.approve_technical`); no role holds both. The old `config.manage_technical` keeps
 * working until the owner approves taking it away. The second-person rule is unchanged.
 */

type Row = Record<string, unknown>;

let h: Harness;
let proposer: LoggedInAccount;
let approver: LoggedInAccount;
let both: LoggedInAccount;
let legacy: LoggedInAccount;
let legacy2: LoggedInAccount;

const as = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });
const propose = (who: LoggedInAccount, key: string, value: unknown) =>
  as(who, 'POST', '/config/proposals', {
    key,
    scope: { level: 'global' },
    value,
    reason: 'آزمون تفکیک تنظیمات فنی',
  });
const decide = (who: LoggedInAccount, id: string, outcome: 'approve' | 'reject') =>
  as(who, 'POST', `/config/proposals/${id}/${outcome}`, {});

async function role(permissions: string[]) {
  const code = `tech_${Math.random().toString(36).slice(2, 10)}`;
  await h.app.get(AccessService).createRole(CLI_ACTOR, {
    code,
    name: 'آزمون تنظیمات فنی',
    permissions: permissions as never,
    reason: 'test fixture',
  });
  return code;
}

beforeAll(async () => {
  h = await startHarness();
  const proposeOnly = await role(['config.read', 'config.propose_technical']);
  proposer = await loggedInAccount(h, 'staff');
  await grantRole(h, proposer.id, proposeOnly);
  approver = await loggedInAccount(h, 'staff');
  await grantRole(h, approver.id, 'technical_config_approver');
  both = await loggedInAccount(h, 'staff');
  await grantRole(h, both.id, proposeOnly);
  await grantRole(h, both.id, 'technical_config_approver');
  legacy = await loggedInAccount(h, 'staff');
  await grantRole(h, legacy.id, 'system_admin');
  legacy2 = await loggedInAccount(h, 'staff');
  await grantRole(h, legacy2.id, 'system_admin');
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('owner 1405/08/03: technical settings, proposed by one role and decided by another', () => {
  it('the roles as 0107 makes them: no role holds both; the approver role holds one permission', async () => {
    const { rows: mixed } = await h.owner.query<Row>(
      `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.deleted_at IS NULL AND r.deleted_at IS NULL AND r.code NOT LIKE 'tech\\_%'
          AND rp.permission_code IN ('config.propose_technical', 'config.approve_technical')
        GROUP BY r.code HAVING count(DISTINCT rp.permission_code) = 2`,
    );
    expect(mixed).toEqual([]);
    const permsOf = async (code: string) =>
      (
        await h.owner.query<Row>(
          `SELECT rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
            WHERE r.code = $1 AND rp.deleted_at IS NULL ORDER BY 1`,
          [code],
        )
      ).rows.map((r) => r['permission_code']);
    expect(await permsOf('technical_config_approver')).toEqual([
      'config.approve_technical',
      'config.read',
    ]);
    const admin = await permsOf('system_admin');
    expect(admin).toContain('config.propose_technical');
    expect(admin).not.toContain('config.approve_technical');
    // Kept until the owner approves the separate step.
    expect(admin).toContain('config.manage_technical');
    const { rows: held } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM role_assignments a JOIN roles r ON r.id = a.role_id
        WHERE r.code = 'technical_config_approver' AND a.account_id <> ALL($1::uuid[])`,
      [[approver.id, both.id]],
    );
    expect(held[0]?.['n']).toBe(0);
  });

  it('the proposer proposes and cannot decide; the approver decides and cannot propose', async () => {
    const asked = await propose(proposer, 'identity.factor_change_sms', { enabled: true });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = asked.body['id'] as string;
    expect((await decide(proposer, id, 'approve')).body['error']).toBe('permission_required');
    expect(
      (await propose(approver, 'identity.factor_change_sms', { enabled: true })).body,
    ).toMatchObject({ error: 'permission_required' });
    const done = await decide(approver, id, 'approve');
    expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
    expect(done.body).toMatchObject({ status: 'approved' });
  });

  it('one person with both roles still never decides their own proposal (service and database)', async () => {
    const asked = await propose(both, 'identity.factor_change_sms', { enabled: false });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = asked.body['id'] as string;
    expect((await decide(both, id, 'approve')).body['error']).toBe('second_person_required');
    await expect(
      h.owner.query(
        `UPDATE config_values SET status = 'approved', decided_by = proposed_by, decided_at = now()
          WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/second person/);
    expect((await decide(approver, id, 'reject')).status).toBeLessThan(300);
  });

  it('the narrow permissions reach technical keys only; a business key is refused', async () => {
    const res = await propose(proposer, 'booking.center_approval_sla_minutes', 30);
    expect([res.status, res.body['error']]).toEqual([403, 'permission_required']);
  });

  it('until the owner’s separate step, two system administrators still propose and decide', async () => {
    const asked = await propose(legacy, 'identity.factor_change_sms', { enabled: true });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const done = await decide(legacy2, asked.body['id'] as string, 'approve');
    expect(done.body).toMatchObject({ status: 'approved' });
  });
});
