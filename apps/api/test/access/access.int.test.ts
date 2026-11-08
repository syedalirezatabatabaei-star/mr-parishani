import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool';
import { AccessService } from '../../src/modules/access/access.service';
import { AuditChainCheck } from '../../src/modules/audit/audit-chain-check';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { PartitionMaintenance, utcMonthStart } from '../../src/infra/ops/partition-maintenance';
import { TotpResetService } from '../../src/modules/identity/totp-reset.service';
import {
  actorFor,
  call,
  createNode,
  grantRole,
  loggedInAccount,
  newIp,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

let h: Harness;
/** The application role, for checks of row-level security and privileges. */
let app: Pool;
/** Superuser, only to tamper with the audit trail the way an intruder with root would. */
let root: Pool;

/** Center C → doctors A and B → secretary S of A. */
const tree = { center: '', doctorA: '', doctorB: '', secretary: '' };
let doctorA: LoggedInAccount;
let doctorB: LoggedInAccount;
let secretary: LoggedInAccount;
let adminA: LoggedInAccount;
let adminB: LoggedInAccount;

const get = (who: LoggedInAccount, path: string, ip?: string) =>
  call(h, 'GET', path, { bearer: who.access, ...(ip ? { ip } : {}) });
const post = (who: LoggedInAccount, path: string, body?: unknown, ip?: string) =>
  call(h, 'POST', path, {
    bearer: who.access,
    ...(body === undefined ? {} : { body }),
    ...(ip ? { ip } : {}),
  });

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
  root = createPool(h.db.adminUrl, 'test-root');

  [doctorA, doctorB, secretary, adminA, adminB] = await Promise.all([
    loggedInAccount(h, 'center'),
    loggedInAccount(h, 'center'),
    loggedInAccount(h, 'center'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  tree.center = await createNode(h, 'center');
  tree.doctorA = await createNode(h, 'doctor', { parentId: tree.center, accountId: doctorA.id });
  tree.doctorB = await createNode(h, 'doctor', { parentId: tree.center, accountId: doctorB.id });
  tree.secretary = await createNode(h, 'secretary', {
    parentId: tree.doctorA,
    accountId: secretary.id,
  });
  await grantRole(h, doctorA.id, 'doctor', { kind: 'doctor', nodeId: tree.doctorA });
  await grantRole(h, doctorB.id, 'doctor', { kind: 'doctor', nodeId: tree.doctorB });
  await grantRole(h, secretary.id, 'secretary', { kind: 'doctor', nodeId: tree.doctorA });
  await grantRole(h, adminA.id, 'system_admin');
  await grantRole(h, adminB.id, 'system_admin');
});

afterAll(async () => {
  await app.end();
  await root.end();
  await h.close();
});

/** Creates a custom role through the API as adminA. */
async function customRole(code: string, permissions: string[]) {
  const res = await post(adminA, '/access/roles', {
    code,
    name: `نقش ${code}`,
    permissions,
    reason: 'آزمون نقش سفارشی',
  });
  expect(res.status).toBe(201);
}

describe('doc 04 §8 — the six mandatory tests', () => {
  it('1. a secretary cannot reach anything their doctor cannot', async () => {
    // Given more than the doctor has, everywhere: a permission the doctor lacks, globally.
    await customRole('secretary_extra', ['access.read_roles', 'access.read_org']);
    await grantRole(h, secretary.id, 'secretary_extra');

    // The permission is cut: the doctor has no access.read_roles.
    const roles = await get(secretary, '/access/roles');
    expect(roles.status).toBe(403);
    expect(roles.body).toMatchObject({ error: 'permission_required' });

    // The global scope is cut: only the doctor's own subtree remains.
    const nodes = await get(secretary, '/access/org-nodes');
    expect(nodes.status).toBe(200);
    const ids = (nodes.body as unknown as { id: string }[]).map((n) => n.id).sort();
    expect(ids).toEqual([tree.doctorA, tree.secretary].sort());
    expect((await get(secretary, `/access/org-nodes/${tree.doctorB}`)).status).toBe(404);
    expect((await get(secretary, `/access/org-nodes/${tree.center}`)).status).toBe(404);

    const me = await get(secretary, '/access/me');
    expect(me.body['permissions']).not.toContain('access.read_roles');
  });

  it('2. doctor A sees nothing of doctor B, even by guessing ids (IDOR)', async () => {
    expect((await get(doctorA, `/access/org-nodes/${tree.doctorA}`)).status).toBe(200);
    expect((await get(doctorA, `/access/org-nodes/${tree.secretary}`)).status).toBe(200);

    const other = await get(doctorA, `/access/org-nodes/${tree.doctorB}`);
    expect(other.status).toBe(404);
    // Not even the shared clinic.
    expect((await get(doctorA, `/access/org-nodes/${tree.center}`)).status).toBe(404);

    const list = await get(doctorA, '/access/org-nodes');
    const ids = (list.body as unknown as { id: string }[]).map((n) => n.id);
    expect(ids).not.toContain(tree.doctorB);
    expect(ids).not.toContain(tree.center);

    // Nor act on B's side: granting a role to A's secretary is only for A.
    const idor = await post(doctorB, `/access/org-nodes/${tree.secretary}/assignments`, {
      roleCode: 'secretary',
      reason: 'تلاش پزشک دیگر',
    });
    expect(idor.status).toBe(404);
  });

  it('3. the collection unit never receives the treatment, whatever else it holds', async () => {
    const agent = await loggedInAccount(h, 'staff');
    await grantRole(h, agent.id, 'collection');
    // Even a role that grants the treatment explicitly does not help.
    await customRole('collection_plus', [
      'access.read_org',
      'access.view_treatment',
      'access.view_credit_score',
    ]);
    await grantRole(h, agent.id, 'collection_plus');

    const res = await get(agent, '/probe/sensitive');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const field of ['treatmentDescription', 'treatmentField', 'doctorName']) {
      expect(text).not.toContain(field);
    }
    // Amount, due date and what the agent's roles do allow still come through.
    expect(res.body).toMatchObject({ amountRial: '120000000', creditScore: 712 });
    expect(res.body['installments']).toEqual([{ dueAt: '2026-10-01', amountRial: '10000000' }]);
    expect(res.body['history']).toEqual({ last: { note: 'kept' } });

    const me = await get(agent, '/access/me');
    expect(me.body['permissions']).not.toContain('access.view_treatment');
  });

  it('4. a user without the permission gets 403, not 200 with nothing in it', async () => {
    const nobody = await loggedInAccount(h, 'staff');
    for (const path of ['/access/org-nodes', '/access/roles', '/audit/events?entityType=role']) {
      const res = await get(nobody, path);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'permission_required' });
    }
  });

  it('5. two-person approval refuses one user acting twice', async () => {
    const retention = async () =>
      (await get(adminA, '/config/resolve?key=audit.retention')).body['value'];
    const proposal = await post(adminA, '/config/proposals', {
      key: 'audit.retention',
      scope: { level: 'global' },
      value: { months: 30 },
      reason: 'آزمون تأیید دونفره',
    });
    expect(proposal.status).toBe(201);
    const id = proposal.body['id'] as string;
    const self = await post(adminA, `/config/proposals/${id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ error: 'second_person_required' });
    expect(await retention()).toEqual({ months: 24 });

    expect((await post(adminB, `/config/proposals/${id}/approve`)).status).toBe(200);
    expect(await retention()).toEqual({ months: 30 });
    expect((await post(adminB, `/config/proposals/${id}/approve`)).status).toBe(409);

    // TOTP reset through the API: the same rule.
    const target = await loggedInAccount(h, 'staff');
    const reset = await post(adminA, '/identity/totp-resets', {
      targetAccountId: target.id,
      reason: 'گوشی گم شده',
    });
    expect(reset.status).toBe(201);
    const resetId = reset.body['id'] as string;
    expect((await post(adminA, `/identity/totp-resets/${resetId}/approve`)).status).toBe(403);
    expect((await post(adminB, `/identity/totp-resets/${resetId}/approve`)).status).toBe(204);
    expect((await get(target, '/auth/me')).status).toBe(401);
  });

  it('6. a role change applies at once to the active session', async () => {
    const user = await loggedInAccount(h, 'staff');
    expect((await get(user, '/audit/verify')).status).toBe(403);

    const assignmentId = await grantRole(h, user.id, 'auditor');
    expect((await get(user, '/audit/verify')).status).toBe(200);

    const revoked = await post(adminA, `/access/assignments/${assignmentId}/revoke`, {
      reason: 'پایان همکاری',
    });
    expect(revoked.status).toBe(204);
    // Same token, no new login.
    expect((await get(user, '/audit/verify')).status).toBe(403);
  });
});

describe('roles and assignments', () => {
  it('system roles are changed only by migration', async () => {
    const roles = (await get(adminA, '/access/roles')).body as unknown as {
      id: string;
      code: string;
      isSystem: boolean;
      permissions: string[];
    }[];
    const doctor = roles.find((r) => r.code === 'doctor');
    expect(doctor?.isSystem).toBe(true);
    const res = await call(h, 'PUT', `/access/roles/${doctor?.id ?? ''}/permissions`, {
      bearer: adminA.access,
      body: { permissions: ['audit.read'], reason: 'تلاش تغییر نقش سیستمی' },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'system_role_locked' });
  });

  it('seeds the roles of doc 04 without medical content for the system admin', async () => {
    const roles = (await get(adminA, '/access/roles')).body as unknown as {
      code: string;
      permissions: string[];
    }[];
    const codes = roles.map((r) => r.code);
    for (const code of [
      'advisor',
      'network_specialist',
      'case_completion',
      'credit_specialist',
      'strategy_manager',
      'accounting',
      'collection',
      'support',
      'system_admin',
      'ceo',
      'auditor',
      'center_manager',
      'doctor',
      'secretary',
    ]) {
      expect(codes).toContain(code);
    }
    const admin = roles.find((r) => r.code === 'system_admin');
    expect(admin?.permissions.filter((p) => p.startsWith('access.view_'))).toEqual([]);
    const collection = roles.find((r) => r.code === 'collection');
    expect(collection?.permissions).not.toContain('access.view_treatment');
  });

  it('a custom role can be edited, and the change is audited', async () => {
    await customRole('night_shift', ['access.read_org']);
    const roles = (await get(adminA, '/access/roles')).body as unknown as {
      id: string;
      code: string;
    }[];
    const role = roles.find((r) => r.code === 'night_shift');
    const res = await call(h, 'PUT', `/access/roles/${role?.id ?? ''}/permissions`, {
      bearer: adminA.access,
      body: { permissions: ['access.read_org', 'audit.read'], reason: 'نیاز شیفت' },
    });
    expect(res.status).toBe(204);

    const events = await h.app
      .get(AuditService)
      .list({ entityType: 'role', entityId: role?.id ?? '', limit: 10 });
    expect(events[0]).toMatchObject({
      action: 'access.role_permissions_changed',
      actorAccountId: adminA.id,
      before: { permissions: ['access.read_org'] },
      after: { permissions: ['access.read_org', 'audit.read'] },
      reason: 'نیاز شیفت',
    });
    expect(events[0]?.actorRoles).toContain('system_admin');
  });

  it('roles go to staff and center accounts, never to a patient', async () => {
    const patient = await otpLogin(h, newMobile(), 'mobile');
    const me = await call(h, 'GET', '/auth/me', { bearer: patient.body['accessToken'] as string });
    const res = await post(adminA, '/access/assignments', {
      accountId: me.body['accountId'],
      roleCode: 'auditor',
      scope: { kind: 'global' },
      reason: 'نقش برای بیمار',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'patient_account' });
  });

  it('nobody grants roles to themselves', async () => {
    const res = await post(adminA, '/access/assignments', {
      accountId: adminA.id,
      roleCode: 'auditor',
      scope: { kind: 'global' },
      reason: 'خودم',
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'cannot_assign_own_roles' });
  });

  it('a doctor grants their secretary only roles within the doctor’s own access', async () => {
    const tooMuch = await post(doctorA, `/access/org-nodes/${tree.secretary}/assignments`, {
      roleCode: 'auditor',
      reason: 'دسترسی بیشتر',
    });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body).toMatchObject({ error: 'role_exceeds_doctor_access' });

    const ok = await post(doctorA, `/access/org-nodes/${tree.secretary}/assignments`, {
      roleCode: 'secretary',
      reason: 'منشی جدید',
    });
    expect(ok.status).toBe(201);
  });

  it('queue scopes name a team, never a person', async () => {
    const user = await loggedInAccount(h, 'staff');
    const byPerson = await post(adminA, '/access/assignments', {
      accountId: user.id,
      roleCode: 'case_completion',
      scope: { kind: 'queue', code: user.id },
      reason: 'صف شخصی',
    });
    expect(byPerson.status).toBe(400);
    const byTeam = await post(adminA, '/access/assignments', {
      accountId: user.id,
      roleCode: 'case_completion',
      scope: { kind: 'queue', code: 'case_completion' },
      reason: 'صف تیم تکمیل پرونده',
    });
    expect(byTeam.status).toBe(201);
    expect((await get(user, '/access/me')).body['scopes']).toEqual([
      { kind: 'queue', code: 'case_completion' },
    ]);
  });

  it('an advisor is granted its own scope only, and an older wider grant reads as own (R18)', async () => {
    const user = await loggedInAccount(h, 'staff');
    for (const scope of [{ kind: 'global' }, { kind: 'city', code: 'isfahan' }]) {
      const wide = await post(adminA, '/access/assignments', {
        accountId: user.id,
        roleCode: 'advisor',
        scope,
        reason: 'دامنه گسترده',
      });
      expect(wide.status).toBe(400);
      expect(wide.body).toMatchObject({ error: 'scope_not_allowed_for_role' });
    }
    const own = await post(adminA, '/access/assignments', {
      accountId: user.id,
      roleCode: 'advisor',
      scope: { kind: 'own' },
      reason: 'مشاور',
    });
    expect(own.status).toBe(201);
    // A grant written before the rule (data, not the service): still only the advisor's own.
    const older = await loggedInAccount(h, 'staff');
    await h.owner.query(
      `INSERT INTO role_assignments (account_id, role_id, scope_kind, reason, granted_by)
       SELECT $1, id, 'global', 'پیش از R18', NULL FROM roles WHERE code = 'advisor'`,
      [older.id],
    );
    expect((await get(older, '/access/me')).body['scopes']).toEqual([{ kind: 'own' }]);
  });
});

describe('the center tree', () => {
  it('keeps its shape in the database', async () => {
    // A secretary with no doctor, and one directly under a center.
    await expect(
      h.owner.query(
        "INSERT INTO org_nodes (kind, name, city_code, account_id) VALUES ('secretary', 'x', 'tehran', uuidv7())",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.owner.query(
        "INSERT INTO org_nodes (kind, parent_id, name, city_code, account_id) VALUES ('secretary', $1, 'x', 'tehran', uuidv7())",
        [tree.center],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Nodes never move.
    await expect(
      h.owner.query('UPDATE org_nodes SET parent_id = $1 WHERE id = $2', [
        tree.center,
        tree.secretary,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('paths nest, and children take the city of their parent', async () => {
    const { rows } = await h.owner.query<{ id: string; path: string; city_code: string }>(
      'SELECT id, path::text, city_code FROM org_nodes WHERE id = ANY($1)',
      [[tree.center, tree.doctorA, tree.secretary]],
    );
    const path = (id: string) => rows.find((r) => r.id === id)?.path ?? '';
    expect(path(tree.secretary).startsWith(`${path(tree.doctorA)}.`)).toBe(true);
    expect(path(tree.doctorA).startsWith(`${path(tree.center)}.`)).toBe(true);
    expect(new Set(rows.map((r) => r.city_code))).toEqual(new Set(['tehran']));
  });

  it('row-level security: the application role sees nothing without a scope', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      const none = await client.query('SELECT count(*)::int AS n FROM org_nodes');
      expect(none.rows[0]).toEqual({ n: 0 });

      const { rows } = await h.owner.query<{ path: string }>(
        'SELECT path::text FROM org_nodes WHERE id = $1',
        [tree.doctorA],
      );
      await client.query(
        "SELECT set_config('app.rls_mode', 'scoped', true), set_config('app.scope_paths', $1, true)",
        [rows[0]?.path],
      );
      const scoped = await client.query<{ id: string }>('SELECT id FROM org_nodes');
      expect(scoped.rows.map((r) => r.id).sort()).toEqual([tree.doctorA, tree.secretary].sort());

      // Scoped reads cannot write.
      await expect(
        client.query(
          "INSERT INTO org_nodes (kind, name, city_code) VALUES ('center', 'sneaky', 'tehran')",
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('records who viewed a node in the access log', async () => {
    await get(doctorA, `/access/org-nodes/${tree.secretary}`);
    const { rows } = await h.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM access_logs WHERE entity_type = 'org_node' AND entity_id = $1 AND account_id = $2",
      [tree.secretary, doctorA.id],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});

describe('the permissions table', () => {
  it('must match the code, or the API refuses to start', async () => {
    const access = h.app.get(AccessService);
    await expect(access.onApplicationBootstrap()).resolves.toBeUndefined();
    await h.owner.query(
      "UPDATE permissions SET deleted_at = now() WHERE code = 'settlement.approve'",
    );
    try {
      await expect(access.onApplicationBootstrap()).rejects.toThrow('settlement.approve');
    } finally {
      await h.owner.query(
        "UPDATE permissions SET deleted_at = NULL WHERE code = 'settlement.approve'",
      );
    }
  });

  it('is written by migrations only', async () => {
    await expect(
      app.query("INSERT INTO permissions (code) VALUES ('audit.erase')"),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('audit trail', () => {
  it('is append-only, even for the schema owner', async () => {
    await expect(app.query("UPDATE audit_events SET reason = 'x'")).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
    await expect(h.owner.query("UPDATE audit_events SET reason = 'x'")).rejects.toMatchObject({
      code: '42501',
    });
    await expect(h.owner.query('DELETE FROM audit_events')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(h.owner.query('TRUNCATE audit_events')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('INVARIANT: the hash chain verifies, and any edit breaks it at that row', async () => {
    const audit = h.app.get(AuditService);
    const before = await audit.verify(7);
    expect(before.ok).toBe(true);
    expect(before.checked).toBeGreaterThan(10);

    const { rows } = await root.query<{ seq: string; reason: string | null }>(
      'SELECT seq::text, reason FROM audit_events ORDER BY seq OFFSET 3 LIMIT 1',
    );
    const target = rows[0];
    const tamper = async (reason: string | null) => {
      const client = await root.connect();
      try {
        // Only a superuser can switch the append-only triggers off like this.
        await client.query('SET session_replication_role = replica');
        await client.query('UPDATE audit_events SET reason = $1 WHERE seq = $2', [
          reason,
          target?.seq,
        ]);
      } finally {
        await client.query('RESET session_replication_role');
        client.release();
      }
    };
    // Task 9-3 (R6): the nightly check opens a notice on a break, and closes it once whole.
    const check = h.app.get(AuditChainCheck);
    const notice = async () =>
      (
        await root.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM admin_notices
           WHERE code = 'audit_chain_broken' AND resolved_at IS NULL`,
        )
      ).rows[0]?.n;
    await tamper('ویرایش مخفیانه');
    try {
      expect(await audit.verify(7)).toMatchObject({ ok: false, brokenAt: target?.seq });
      expect(await check.run()).toMatchObject({ ok: false });
      expect(await notice()).toBe(1);
    } finally {
      await tamper(target?.reason ?? null);
    }
    expect((await audit.verify()).ok).toBe(true);
    expect(await check.run()).toMatchObject({ ok: true });
    expect(await notice()).toBe(0);
  });

  it('keeps the chain linear under concurrent writes', async () => {
    const audit = h.app.get(AuditService);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        audit.record({
          actor: actorFor(adminA.id),
          action: 'test.concurrent',
          entityType: 'test',
          entityId: String(i),
          after: { i, amountRial: '1000' },
        }),
      ),
    );
    expect(await audit.verify()).toMatchObject({ ok: true, brokenAt: null });
  });

  it('auditors read it through the API', async () => {
    const auditor = await loggedInAccount(h, 'staff');
    await grantRole(h, auditor.id, 'auditor');
    const events = await get(
      auditor,
      `/audit/events?entityType=user_account&entityId=${auditor.id}`,
    );
    expect(events.status).toBe(200);
    expect(events.body).toEqual([
      expect.objectContaining({ action: 'access.role_assigned', actorRoles: ['cli'] }),
    ]);
    const verify = await get(auditor, '/audit/verify');
    expect(verify.body).toMatchObject({ ok: true });
  });
});

describe('audit partitions', () => {
  it('exist for this month and the next twelve', async () => {
    const names = [0, 12].map(
      (offset) => `audit_events_${utcMonthStart(new Date(), offset).slice(0, 7).replace('-', '_')}`,
    );
    for (const name of names) {
      const { rows } = await h.owner.query('SELECT to_regclass($1) AS t', [name]);
      expect(rows[0]).toEqual({ t: name });
    }
  });

  it('are archived (detached, never dropped) past the retention', async () => {
    const maintenance = new PartitionMaintenance(
      h.app.get<Database>(DATABASE),
      h.app.get<ConfigPort>(CONFIG),
    );
    await h.owner.query("SELECT audit_ensure_partitions('2020-01-01', 1)");
    const result = await maintenance.run();
    expect(result.detached).toEqual(['access_logs_2020_01', 'audit_events_2020_01']);

    const { rows } = await h.owner.query(
      "SELECT to_regclass('audit_events_2020_01') AS t, (SELECT count(*)::int FROM pg_inherits WHERE inhrelid = 'audit_events_2020_01'::regclass) AS attached",
    );
    expect(rows[0]).toEqual({ t: 'audit_events_2020_01', attached: 0 });
    await expect(app.query('SELECT 1 FROM audit_events_2020_01')).rejects.toMatchObject({
      code: '42501',
    });
    // The current month stays.
    expect((await maintenance.run()).detached).toEqual([]);
  });
});

describe('TOTP reset requests', () => {
  it('expire after 6 hours without a second person', async () => {
    const target = await loggedInAccount(h, 'staff');
    const resets = h.app.get(TotpResetService);
    const id = await resets.request(actorFor(adminA.id), target.id, 'گوشی گم شده');
    // A minute past the 6 hours: `created_at` is the database's clock, which in a container may
    // run seconds ahead of this host's (owner 1405/07/29: tests bound to clocks reviewed).
    const later = new Date(Date.now() + 6 * 60 * 60 * 1000 + 60_000);
    await expect(resets.approve(actorFor(adminB.id), id, later)).rejects.toMatchObject({
      status: 410,
    });
    const { rows } = await h.owner.query('SELECT status FROM totp_reset_requests WHERE id = $1', [
      id,
    ]);
    expect(rows[0]).toEqual({ status: 'expired' });
    await expect(resets.approve(actorFor(adminB.id), id)).rejects.toMatchObject({ status: 409 });
    expect((await get(target, '/auth/me')).status).toBe(200);
  });
});

describe('internal panel IP allow-list (versioned configuration)', () => {
  const office = '10.250.7.7';

  async function setAllowlist(value: { enabled: boolean; cidrs: string[] }) {
    const proposal = await post(
      adminA,
      '/config/proposals',
      {
        key: 'access.internal_panel_ip_allowlist',
        scope: { level: 'global' },
        value,
        reason: 'شبکه دفتر',
      },
      office,
    );
    expect(proposal.status).toBe(201);
    const approved = await post(
      adminB,
      `/config/proposals/${proposal.body['id'] as string}/approve`,
      undefined,
      office,
    );
    expect(approved.status).toBe(200);
  }

  it('keeps internal roles outside the listed networks out, never center staff', async () => {
    await setAllowlist({ enabled: true, cidrs: ['10.250.0.0/16'] });
    try {
      const outside = await get(adminA, '/access/roles', newIp().replace(/^10\.\d+/, '10.1'));
      expect(outside.status).toBe(403);
      expect(outside.body).toMatchObject({ error: 'network_not_allowed' });
      expect((await get(adminA, '/access/roles', office)).status).toBe(200);
      // Center users work from their clinics.
      expect((await get(doctorA, '/access/org-nodes', '10.1.2.3')).status).toBe(200);
      // The limit follows the role, not only the kind of account (owner, task 2-11): a center
      // account holding an internal (global) role is held to the office network too.
      const mixed = await loggedInAccount(h, 'center');
      await grantRole(h, mixed.id, 'system_admin');
      const fromClinic = await get(mixed, '/access/roles', '10.1.2.3');
      expect(fromClinic.status).toBe(403);
      expect(fromClinic.body).toMatchObject({ error: 'network_not_allowed' });
      expect((await get(mixed, '/access/roles', office)).status).toBe(200);
      // A secretary (a doctor's scope only) and a patient are never held to it.
      expect((await get(secretary, '/auth/me', '10.1.2.3')).status).toBe(200);
    } finally {
      await setAllowlist({ enabled: false, cidrs: [] });
    }
    expect((await get(adminA, '/access/roles', '10.1.2.3')).status).toBe(200);
  });

  it('is closed by default: migration 0076 lists no network, so no internal role gets in (R10)', async () => {
    const { rows } = await h.owner.query<{ value: unknown }>(
      `SELECT value FROM config_values
        WHERE key = 'access.internal_panel_ip_allowlist' AND reason LIKE '%0076%'`,
    );
    expect(rows.map((r) => r.value)).toEqual([{ enabled: true, cidrs: [] }]);
    // That version in effect again (written as the migration does: nobody could approve it
    // through the API once it holds, the point of the test).
    const put = (value: string) =>
      h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('access.internal_panel_ip_allowlist', 'global', $1::jsonb, $2, 'approved',
                 'test', $2)`,
        // The API's clock, not the container's: a start a moment ahead would not hold yet.
        [value, new Date()],
      );
    await put('{"enabled": true, "cidrs": []}');
    try {
      for (const ip of [office, '10.1.2.3', '127.0.0.1']) {
        const res = await get(adminA, '/access/roles', ip);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'network_not_allowed' });
      }
      // Center staff work from their clinics, closed or not.
      expect((await get(doctorA, '/access/org-nodes', '10.1.2.3')).status).toBe(200);
    } finally {
      await put('{"enabled": false, "cidrs": []}');
    }
  });
});
