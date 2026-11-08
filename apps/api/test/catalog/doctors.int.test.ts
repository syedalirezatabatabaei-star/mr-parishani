import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionCode } from '@sepehr/contracts';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AccessService } from '../../src/modules/access/access.service';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import {
  call,
  grantRole,
  loggedInAccount,
  newAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { councilNumber, nationalId, sheba } from './fixtures';

let h: Harness;
let specialist: LoggedInAccount;
let managerA: LoggedInAccount;
let managerB: LoggedInAccount;

const api = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

const reason = { reason: 'آزمون پزشک' };

interface Center {
  id: string;
  nodeId: string;
  branchId: string;
}

/** A center taken through review to an approved activation, with its default branch. */
async function activeCenter(): Promise<Center> {
  const created = await api(specialist, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: 'کلینیک پزشکان',
    cityCode: 'tehran',
    sheba: sheba(),
    accountHolderName: 'صاحب حساب',
  });
  expect(created.status).toBe(201);
  const id = created.body['id'] as string;
  const setAll = async (status: string) => {
    const detail = await api(specialist, 'GET', `/catalog/centers/${id}`);
    for (const doc of detail.body['documents'] as { code: string }[]) {
      await api(specialist, 'PUT', `/catalog/centers/${id}/documents/${doc.code}`, { status });
    }
  };
  await setAll('received');
  await api(specialist, 'POST', `/catalog/centers/${id}/submit`, reason);
  await setAll('verified');
  const proposed = await api(
    specialist,
    'POST',
    `/catalog/centers/${id}/activation-requests`,
    reason,
  );
  const approved = await api(
    managerB,
    'POST',
    `/catalog/requests/${proposed.body['id'] as string}/approve`,
    {},
  );
  expect(approved.status).toBe(200);
  const detail = await api(specialist, 'GET', `/catalog/centers/${id}`);
  const [branch] = detail.body['branches'] as { id: string }[];
  return { id, nodeId: created.body['nodeId'] as string, branchId: branch?.id ?? '' };
}

async function register(
  who: LoggedInAccount,
  branchId: string,
  extra: Record<string, unknown> = {},
) {
  const res = await api(who, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: 'دکتر آزمون',
    medicalCouncilNumber: councilNumber(),
    workplace: { kind: 'branch', branchId },
    ...reason,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; medicalCouncilNumber: string };
}

async function workplacesOf(id: string) {
  const res = await api(specialist, 'GET', `/catalog/doctors/${id}`);
  return res.body['workplaces'] as { id: string; nodeId: string; branchId: string | null }[];
}

/** A doctor with an account and a live session at `branchId`. */
async function doctorWithAccount(branchId: string) {
  const doctor = await register(specialist, branchId);
  const account = await loggedInAccount(h, 'center');
  const linked = await api(specialist, 'POST', `/catalog/doctors/${doctor.id}/account`, {
    accountId: account.id,
    ...reason,
  });
  expect(linked.status).toBe(201);
  return { doctor, account };
}

async function customRole(permissions: PermissionCode[]) {
  const code = `sec_${Math.random().toString(36).slice(2, 10)}`;
  await h.app
    .get(AccessService)
    .createRole(CLI_ACTOR, { code, name: 'نقش منشی', permissions, reason: 'test fixture' });
  return code;
}

async function newSecretary(who: LoggedInAccount, workplaceId: string) {
  const account = await loggedInAccount(h, 'center');
  const res = await api(who, 'POST', '/catalog/secretaries', {
    workplaceId,
    accountId: account.id,
    name: 'منشی آزمون',
    ...reason,
  });
  expect(res.status).toBe(201);
  return { account, secretary: res.body as { id: string; nodeId: string } };
}

beforeAll(async () => {
  h = await startHarness();
  [specialist, managerA, managerB] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, managerA.id, 'network_manager');
  await grantRole(h, managerB.id, 'network_manager');
});

afterAll(async () => {
  await h.close();
});

describe('registration', () => {
  it('registers a profile with its first workplace on the tree; the council number is unique', async () => {
    const center = await activeCenter();
    const id = nationalId();
    const doctor = await register(specialist, center.branchId, { nationalId: id });
    const [workplace] = await workplacesOf(doctor.id);
    const node = await h.owner.query(
      'SELECT kind, parent_id, account_id FROM org_nodes WHERE id = $1',
      [workplace?.nodeId],
    );
    const branch = await h.owner.query('SELECT node_id FROM branches WHERE id = $1', [
      center.branchId,
    ]);
    expect(node.rows[0]).toEqual({
      kind: 'doctor',
      parent_id: (branch.rows[0] as { node_id: string }).node_id,
      account_id: null,
    });

    // Stored encrypted; only the last four digits come back.
    const stored = await h.owner.query('SELECT * FROM doctors WHERE id = $1', [doctor.id]);
    expect(JSON.stringify(stored.rows[0])).not.toContain(id);
    const view = await api(specialist, 'GET', `/catalog/doctors/${doctor.id}`);
    expect(view.body['nationalIdLast4']).toBe(id.slice(-4));
    expect(JSON.stringify(view.body)).not.toContain(id);

    const persian = doctor.medicalCouncilNumber.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d);
    const again = await api(specialist, 'POST', '/catalog/doctors', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      name: 'دکتر دوم',
      medicalCouncilNumber: persian,
      workplace: { kind: 'branch', branchId: center.branchId },
      ...reason,
    });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('duplicate_medical_council_number');
    const bad = await api(specialist, 'POST', '/catalog/doctors', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      name: 'دکتر',
      medicalCouncilNumber: 'پ-12',
      workplace: { kind: 'branch', branchId: center.branchId },
      ...reason,
    });
    expect(bad.status).toBe(400);
  });

  it('only at an active center; a center manager at their own center only', async () => {
    const draft = await api(specialist, 'POST', '/catalog/centers', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'natural',
      identifier: nationalId(),
      name: 'مرکز پیش‌نویس',
      cityCode: 'tehran',
    });
    const draftDetail = await api(
      specialist,
      'GET',
      `/catalog/centers/${draft.body['id'] as string}`,
    );
    const [draftBranch] = draftDetail.body['branches'] as { id: string }[];
    const early = await api(specialist, 'POST', '/catalog/doctors', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      name: 'دکتر',
      medicalCouncilNumber: councilNumber(),
      workplace: { kind: 'branch', branchId: draftBranch?.id },
      ...reason,
    });
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('center_not_active');

    const mine = await activeCenter();
    const theirs = await activeCenter();
    const manager = await loggedInAccount(h, 'staff');
    await grantRole(h, manager.id, 'center_manager', { kind: 'center', nodeId: mine.nodeId });
    await register(manager, mine.branchId);
    const elsewhere = await api(manager, 'POST', '/catalog/doctors', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      name: 'دکتر',
      medicalCouncilNumber: councilNumber(),
      workplace: { kind: 'branch', branchId: theirs.branchId },
      ...reason,
    });
    expect(elsewhere.status).toBe(404);
    const practice = await api(manager, 'POST', '/catalog/doctors', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      name: 'دکتر',
      medicalCouncilNumber: councilNumber(),
      workplace: { kind: 'private_practice', cityCode: 'tehran' },
      ...reason,
    });
    expect(practice.status).toBe(403);
  });

  it('one profile, several workplaces; the account and the doctor role reach every one', async () => {
    const first = await activeCenter();
    const second = await activeCenter();
    const { doctor, account } = await doctorWithAccount(first.branchId);
    const added = await api(specialist, 'POST', `/catalog/doctors/${doctor.id}/workplaces`, {
      workplace: { kind: 'branch', branchId: second.branchId },
      ...reason,
    });
    expect(added.status).toBe(201);
    const twice = await api(specialist, 'POST', `/catalog/doctors/${doctor.id}/workplaces`, {
      workplace: { kind: 'branch', branchId: second.branchId },
      ...reason,
    });
    expect(twice.status).toBe(409);

    const nodes = await h.owner.query(
      `SELECT count(*)::int AS n FROM org_nodes WHERE kind = 'doctor' AND account_id = $1`,
      [account.id],
    );
    expect(nodes.rows[0]).toEqual({ n: 2 });
    const me = await api(account, 'GET', '/access/me');
    expect(me.body['roles']).toEqual(['doctor']);
    expect(
      (me.body['scopes'] as { kind: string }[]).filter((s) => s.kind === 'doctor'),
    ).toHaveLength(2);
    const own = await api(account, 'GET', `/catalog/doctors/${doctor.id}`);
    expect(own.status).toBe(200);
    expect(own.body['workplaces']).toHaveLength(2);
  });
});

describe('the contract term at registration (owner 1405/07/27, ADR-046)', () => {
  it('a center or a doctor is never registered without it; with it, a proposal waiting for a second person', async () => {
    const center = await activeCenter();
    // Without the term: refused, nothing made.
    const bareCenter = await api(specialist, 'POST', '/catalog/centers', {
      personType: 'natural',
      identifier: nationalId(),
      name: 'کلینیک بی مدت',
      cityCode: 'tehran',
    });
    expect(bareCenter.status).toBe(400);
    const council = councilNumber();
    const bareDoctor = await api(specialist, 'POST', '/catalog/doctors', {
      name: 'دکتر بی مدت',
      medicalCouncilNumber: council,
      workplace: { kind: 'branch', branchId: center.branchId },
      ...reason,
    });
    expect(bareDoctor.status).toBe(400);
    const { rows: none } = await h.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM doctors WHERE medical_council_number = $1',
      [council],
    );
    expect(none[0]?.['n']).toBe(0);
    // The center's: proposed at its node, by whoever registered it, not yet in force.
    const proposals = async (level: string, ref: string) =>
      (
        await h.owner.query<Record<string, unknown>>(
          `SELECT value, status, proposed_by FROM config_values
            WHERE key = 'settlement.provider_contract' AND scope_level = $1 AND scope_ref = $2`,
          [level, ref],
        )
      ).rows;
    expect(await proposals('center', center.nodeId)).toEqual([
      {
        value: { startsOn: '2026-10-01', months: 12 },
        status: 'proposed',
        proposed_by: specialist.id,
      },
    ]);
    // The doctor's: at the workplace's doctor node.
    const doctor = await register(specialist, center.branchId, {
      contractTerm: { startsOn: '2026-11-01', months: 6 },
    });
    const [workplace] = await workplacesOf(doctor.id);
    expect(await proposals('doctor', workplace?.nodeId ?? '')).toEqual([
      {
        value: { startsOn: '2026-11-01', months: 6 },
        status: 'proposed',
        proposed_by: specialist.id,
      },
    ]);
    // A term that is not 3, 6 or 12 months: refused.
    const odd = await api(specialist, 'POST', '/catalog/doctors', {
      contractTerm: { startsOn: '2026-11-01', months: 4 },
      name: 'دکتر مدت نادرست',
      medicalCouncilNumber: councilNumber(),
      workplace: { kind: 'branch', branchId: center.branchId },
      ...reason,
    });
    expect(odd.status).toBe(400);
  });
});

describe('ACCEPTANCE (doc 08 §15 test 7): doctor A sees nothing of doctor B; the clinic manager sees both', () => {
  it('holds for reading, listing and editing, even with the other id', async () => {
    const center = await activeCenter();
    const a = await doctorWithAccount(center.branchId);
    const b = await doctorWithAccount(center.branchId);

    expect((await api(a.account, 'GET', `/catalog/doctors/${a.doctor.id}`)).status).toBe(200);
    expect((await api(a.account, 'GET', `/catalog/doctors/${b.doctor.id}`)).status).toBe(404);
    const list = await api(a.account, 'GET', '/catalog/doctors');
    expect((list.body as unknown as { id: string }[]).map((d) => d.id)).toEqual([a.doctor.id]);
    const edit = await api(a.account, 'PATCH', `/catalog/doctors/${b.doctor.id}`, {
      name: 'دستکاری',
      ...reason,
    });
    expect(edit.status).toBe(404);
    const [bPlace] = await workplacesOf(b.doctor.id);
    const secretary = await api(a.account, 'POST', '/catalog/secretaries', {
      workplaceId: bPlace?.id,
      accountId: (await newAccount(h, 'center')).id,
      name: 'منشی',
      ...reason,
    });
    expect(secretary.status).toBe(404);

    const clinic = await loggedInAccount(h, 'staff');
    await grantRole(h, clinic.id, 'center_manager', { kind: 'center', nodeId: center.nodeId });
    const both = await api(clinic, 'GET', '/catalog/doctors');
    expect((both.body as unknown as { id: string }[]).map((d) => d.id).sort()).toEqual(
      [a.doctor.id, b.doctor.id].sort(),
    );
    expect((await api(clinic, 'GET', `/catalog/doctors/${a.doctor.id}`)).status).toBe(200);
    expect((await api(clinic, 'GET', `/catalog/doctors/${b.doctor.id}`)).status).toBe(200);

    // The doctor edits their own name, but not their council number.
    expect(
      (
        await api(a.account, 'PATCH', `/catalog/doctors/${a.doctor.id}`, {
          name: 'دکتر الف',
          ...reason,
        })
      ).status,
    ).toBe(200);
    const identity = await api(a.account, 'PATCH', `/catalog/doctors/${a.doctor.id}`, {
      medicalCouncilNumber: councilNumber(),
      ...reason,
    });
    expect(identity.status).toBe(403);
  });
});

describe('ACCEPTANCE (doc 08 §15 test 6): a secretary never reaches another doctor', () => {
  it('sees and edits their own doctor only, recorded on that doctor’s behalf', async () => {
    const center = await activeCenter();
    const a = await doctorWithAccount(center.branchId);
    const b = await doctorWithAccount(center.branchId);
    const [aPlace] = await workplacesOf(a.doctor.id);
    const [bPlace] = await workplacesOf(b.doctor.id);
    const { account: secretary, secretary: node } = await newSecretary(a.account, aPlace?.id ?? '');

    // The doctor decides what the secretary may do, never more than they hold.
    const role = await customRole([
      'catalog.read_doctors',
      'catalog.manage_doctors',
      'access.read_org',
    ]);
    const granted = await api(a.account, 'POST', `/access/org-nodes/${node.nodeId}/assignments`, {
      roleCode: role,
      ...reason,
    });
    expect(granted.status).toBe(201);
    const tooMuch = await customRole(['catalog.read_doctors', 'catalog.manage_centers']);
    const refused = await api(a.account, 'POST', `/access/org-nodes/${node.nodeId}/assignments`, {
      roleCode: tooMuch,
      ...reason,
    });
    expect(refused.status).toBe(403);

    expect((await api(secretary, 'GET', `/catalog/doctors/${a.doctor.id}`)).status).toBe(200);
    expect((await api(secretary, 'GET', `/catalog/doctors/${b.doctor.id}`)).status).toBe(404);
    const list = await api(secretary, 'GET', '/catalog/doctors');
    expect((list.body as unknown as { id: string }[]).map((d) => d.id)).toEqual([a.doctor.id]);
    expect(
      (
        await api(secretary, 'PATCH', `/catalog/doctors/${b.doctor.id}`, {
          name: 'دستکاری',
          ...reason,
        })
      ).status,
    ).toBe(404);
    const another = await api(secretary, 'POST', '/catalog/secretaries', {
      workplaceId: bPlace?.id,
      accountId: (await newAccount(h, 'center')).id,
      name: 'منشی',
      ...reason,
    });
    expect(another.status).toBe(404);
    // Nor a second secretary for their own doctor: that is the doctor's call.
    const own = await api(secretary, 'POST', '/catalog/secretaries', {
      workplaceId: aPlace?.id,
      accountId: (await newAccount(h, 'center')).id,
      name: 'منشی',
      ...reason,
    });
    expect(own.status).toBe(403);

    const renamed = await api(secretary, 'PATCH', `/catalog/doctors/${a.doctor.id}`, {
      name: 'دکتر با منشی',
      ...reason,
    });
    expect(renamed.status).toBe(200);
    const audit = await h.owner.query(
      `SELECT actor_account_id, on_behalf_of_doctor_id FROM audit_events
       WHERE action = 'catalog.doctor_updated' AND entity_id = $1`,
      [a.doctor.id],
    );
    expect(audit.rows).toEqual([
      { actor_account_id: secretary.id, on_behalf_of_doctor_id: a.doctor.id },
    ]);
  });

  // The calendar half of doc 08 §15 test 6 (task 2-5): a secretary cannot see or change
  // another doctor's calendar, even with a tampered id. It lives with the calendar, in
  // test/booking/calendar.int.test.ts («secretaries (doc 08 §15 test 6)»).
});

describe('a doctor without an account (task 2-3 decision)', () => {
  it('the center manager delegates to the secretary, capped by the doctor role and by their own access', async () => {
    const center = await activeCenter();
    const doctor = await register(specialist, center.branchId);
    const [place] = await workplacesOf(doctor.id);
    const manager = await loggedInAccount(h, 'staff');
    await grantRole(h, manager.id, 'center_manager', { kind: 'center', nodeId: center.nodeId });
    const { account: secretary, secretary: node } = await newSecretary(manager, place?.id ?? '');

    const beyondDoctor = await customRole(['catalog.read_doctors', 'catalog.manage_centers']);
    const r1 = await api(manager, 'POST', `/catalog/secretaries/${node.id}/assignments`, {
      roleCode: beyondDoctor,
      ...reason,
    });
    expect(r1.status).toBe(403);
    expect(r1.body['error']).toBe('role_exceeds_doctor_access');
    const beyondManager = await customRole(['catalog.read_doctors', 'access.view_treatment']);
    const r2 = await api(manager, 'POST', `/catalog/secretaries/${node.id}/assignments`, {
      roleCode: beyondManager,
      ...reason,
    });
    expect(r2.status).toBe(403);
    expect(r2.body['error']).toBe('role_exceeds_own_access');

    const role = await customRole(['catalog.read_doctors', 'catalog.manage_doctors']);
    const ok = await api(manager, 'POST', `/catalog/secretaries/${node.id}/assignments`, {
      roleCode: role,
      ...reason,
    });
    expect(ok.status).toBe(201);
    const assigned = await h.owner.query(
      `SELECT actor_account_id, on_behalf_of_doctor_id FROM audit_events
       WHERE action = 'access.role_assigned' AND entity_id = $1`,
      [secretary.id],
    );
    expect(assigned.rows).toEqual([
      { actor_account_id: manager.id, on_behalf_of_doctor_id: doctor.id },
    ]);

    // Resolved on every request: nothing beyond the doctor role, only this doctor's node.
    const me = await api(secretary, 'GET', '/access/me');
    expect(me.body['permissions']).toEqual(['catalog.manage_doctors', 'catalog.read_doctors']);
    expect(me.body['scopes']).toEqual([
      expect.objectContaining({ kind: 'doctor', nodeId: place?.nodeId }),
    ]);
    expect((await api(secretary, 'GET', `/catalog/doctors/${doctor.id}`)).status).toBe(200);

    // A secretary never delegates, and a doctor with an account decides alone.
    expect(
      (
        await api(secretary, 'POST', `/catalog/secretaries/${node.id}/assignments`, {
          roleCode: role,
          ...reason,
        })
      ).status,
    ).toBe(403);
    const withAccount = await doctorWithAccount(center.branchId);
    const [theirPlace] = await workplacesOf(withAccount.doctor.id);
    const { secretary: theirs } = await newSecretary(manager, theirPlace?.id ?? '');
    const decides = await api(manager, 'POST', `/catalog/secretaries/${theirs.id}/assignments`, {
      roleCode: role,
      ...reason,
    });
    expect(decides.status).toBe(409);
    expect(decides.body['error']).toBe('doctor_decides');
  });

  it('the audit chain still verifies with the new column', async () => {
    const result = await h.app.get(AuditService).verify();
    expect(result.ok).toBe(true);
  });
});
