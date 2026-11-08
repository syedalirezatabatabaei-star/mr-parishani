import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CENTER_DIRECTORY,
  type CenterDirectory,
} from '../../src/common/catalog/center-directory.port';
import { createPool } from '../../src/db/pool';
import {
  call,
  createNode,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { legalId, nationalId, sheba } from './fixtures';

let h: Harness;
let app: Pool;
let specialist: LoggedInAccount;
let otherCitySpecialist: LoggedInAccount;
let managerA: LoggedInAccount;
let managerB: LoggedInAccount;
let accountant: LoggedInAccount;

// --- API helpers ---------------------------------------------------------------------

const api = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, `/catalog${path}`, {
    bearer: who.access,
    ...(body === undefined ? {} : { body }),
  });

const reason = { reason: 'آزمون مرکز' };

async function newCenter(who: LoggedInAccount, extra: Record<string, unknown> = {}) {
  const res = await api(who, 'POST', '/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: 'کلینیک آزمون',
    cityCode: 'tehran',
    address: 'تهران، خیابان آزمون',
    location: { latitude: 35.6892, longitude: 51.389 },
    phone: '02188776655',
    treatmentFieldCodes: ['dental'],
    sheba: sheba(),
    accountHolderName: 'صاحب حساب',
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; nodeId: string; status: string };
}

async function receiveAll(who: LoggedInAccount, id: string, status = 'received') {
  const center = await api(who, 'GET', `/centers/${id}`);
  for (const doc of center.body['documents'] as { code: string }[]) {
    const res = await api(who, 'PUT', `/centers/${id}/documents/${doc.code}`, { status });
    expect(res.status).toBe(200);
  }
}

/** Registers a center and takes it through review to an approved activation. */
async function activeCenter(approver = managerB, extra: Record<string, unknown> = {}) {
  const center = await newCenter(specialist, extra);
  await receiveAll(specialist, center.id);
  expect((await api(specialist, 'POST', `/centers/${center.id}/submit`, reason)).status).toBe(200);
  await receiveAll(specialist, center.id, 'verified');
  const proposed = await api(managerA, 'POST', `/centers/${center.id}/activation-requests`, reason);
  expect(proposed.status).toBe(201);
  const approved = await api(
    approver,
    'POST',
    `/requests/${proposed.body['id'] as string}/approve`,
    {},
  );
  expect(approved.status).toBe(200);
  return center;
}

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
  // Field codes come from the catalog since task 2-4.
  await h.owner.query(`INSERT INTO treatment_fields (code, name) VALUES ('dental', 'دندانپزشکی')`);
  [specialist, otherCitySpecialist, managerA, managerB, accountant] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, otherCitySpecialist.id, 'network_specialist', {
    kind: 'city',
    code: 'shiraz',
  });
  await grantRole(h, managerA.id, 'network_manager');
  await grantRole(h, managerB.id, 'network_manager');
  await grantRole(h, accountant.id, 'accounting');
});

afterAll(async () => {
  await app.end();
  await h.close();
});

describe('the tree gains branches (migration 0010)', () => {
  it('a branch sits only under a center; a doctor under a center or a branch', async () => {
    const center = await createNode(h, 'center');
    const doctorUnderCenter = await createNode(h, 'doctor', { parentId: center });
    expect(doctorUnderCenter).toBeTruthy();
    const { rows } = await h.owner.query(
      `INSERT INTO org_nodes (kind, parent_id, name, city_code) VALUES ('branch', $1, 'شعبه', 'x') RETURNING id, city_code`,
      [center],
    );
    const branch = rows[0] as { id: string; city_code: string };
    expect(branch.city_code).toBe('tehran'); // inherited, whatever was given
    await expect(createNode(h, 'doctor', { parentId: branch.id })).resolves.toBeTruthy();
    await expect(
      h.owner.query(
        `INSERT INTO org_nodes (kind, name, city_code) VALUES ('branch', 'شعبه', 'tehran')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.owner.query(
        `INSERT INTO org_nodes (kind, parent_id, name, city_code) VALUES ('branch', $1, 'شعبه', 'tehran')`,
        [doctorUnderCenter],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('registration', () => {
  it('creates the center, its tree nodes and a default branch', async () => {
    const center = await newCenter(specialist);
    expect(center.status).toBe('draft');
    const detail = await api(specialist, 'GET', `/centers/${center.id}`);
    expect(detail.status).toBe(200);
    const branches = detail.body['branches'] as { isDefault: boolean; nodeId: string }[];
    expect(branches).toHaveLength(1);
    expect(branches[0]?.isDefault).toBe(true);
    expect(detail.body['treatmentFieldCodes']).toEqual(['dental']);
    expect(detail.body['location']).toEqual({ latitude: 35.6892, longitude: 51.389 });
    const { rows } = await h.owner.query(
      'SELECT kind, parent_id FROM org_nodes WHERE id = ANY($1) ORDER BY kind DESC',
      [[center.nodeId, branches[0]?.nodeId]],
    );
    expect(rows).toEqual([
      { kind: 'center', parent_id: null },
      { kind: 'branch', parent_id: center.nodeId },
    ]);
  });

  it('stores IDs and Sheba only encrypted; shows and audits only the last four digits', async () => {
    const id = nationalId();
    const account = sheba();
    const center = await newCenter(specialist, { identifier: id, sheba: account });
    const { rows } = await h.owner.query('SELECT * FROM centers WHERE id = $1', [center.id]);
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain(id);
    expect(stored).not.toContain(account.slice(2));
    expect(rows[0]).toMatchObject({
      identifier_last4: id.slice(-4),
      sheba_last4: account.slice(-4),
    });
    const view = await api(specialist, 'GET', `/centers/${center.id}`);
    expect(JSON.stringify(view.body)).not.toContain(id);
    expect(view.body['identifierLast4']).toBe(id.slice(-4));
    const audit = await h.owner.query(
      `SELECT before::text, after::text FROM audit_events WHERE entity_id = $1`,
      [center.id],
    );
    for (const row of audit.rows as { before: string | null; after: string | null }[]) {
      expect(`${row.before ?? ''}${row.after ?? ''}`).not.toContain(id);
      expect(`${row.before ?? ''}${row.after ?? ''}`).not.toContain(account.slice(2));
    }
    // A plaintext value cannot even be written there.
    await expect(
      h.owner.query(`UPDATE centers SET identifier_enc = $2 WHERE id = $1`, [center.id, id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ACCEPTANCE: a second registration with the same ID is refused; so is the same Sheba', async () => {
    const id = legalId();
    const account = sheba();
    await newCenter(specialist, { personType: 'legal', identifier: id, sheba: account });
    const again = await api(specialist, 'POST', '/centers', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'legal',
      identifier: `${id.slice(0, 5)} ${id.slice(5)}`, // same ID, typed differently
      name: 'مرکز دوم',
      cityCode: 'tehran',
    });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('duplicate_identifier');
    const sameSheba = await api(specialist, 'POST', '/centers', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'natural',
      identifier: nationalId(),
      name: 'مرکز سوم',
      cityCode: 'tehran',
      sheba: account.toLowerCase(),
      accountHolderName: 'دیگری',
    });
    expect(sameSheba.status).toBe(409);
    expect(sameSheba.body['error']).toBe('duplicate_sheba');
  });

  it('checks the algorithms before anything is stored', async () => {
    const bad = await api(specialist, 'POST', '/centers', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'natural',
      identifier: '1234567890',
      name: 'مرکز',
      cityCode: 'tehran',
    });
    expect(bad.status).toBe(400);
    const badSheba = await api(specialist, 'POST', '/centers', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'natural',
      identifier: nationalId(),
      name: 'مرکز',
      cityCode: 'tehran',
      sheba: 'IR000000000000000000000000',
      accountHolderName: 'صاحب',
    });
    expect(badSheba.status).toBe(400);
  });

  it('is limited to the specialist’s city; another city sees nothing (404)', async () => {
    const center = await newCenter(specialist);
    expect((await api(otherCitySpecialist, 'GET', `/centers/${center.id}`)).status).toBe(404);
    const list = await api(otherCitySpecialist, 'GET', '/centers');
    expect((list.body as unknown as { id: string }[]).some((c) => c.id === center.id)).toBe(false);
    const elsewhere = await api(otherCitySpecialist, 'POST', '/centers', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'natural',
      identifier: nationalId(),
      name: 'مرکز',
      cityCode: 'tehran',
    });
    expect(elsewhere.status).toBe(403);
  });
});

describe('review and the status machine', () => {
  it('submission needs every checklist document and a bank account', async () => {
    const center = await newCenter(specialist);
    const early = await api(specialist, 'POST', `/centers/${center.id}/submit`, reason);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({
      error: 'automatic_checks_failed',
      problems: ['documents_missing'],
    });
    await receiveAll(specialist, center.id);
    expect((await api(specialist, 'POST', `/centers/${center.id}/submit`, reason)).status).toBe(
      200,
    );

    // Under review, only contact details change.
    const rename = await api(specialist, 'PATCH', `/centers/${center.id}`, {
      name: 'نام تازه',
      ...reason,
    });
    expect(rename.status).toBe(409);
    const phone = await api(specialist, 'PATCH', `/centers/${center.id}`, {
      phone: '02111112222',
      ...reason,
    });
    expect(phone.status).toBe(200);

    // Back for a fix, then resubmitted.
    const fix = await api(managerA, 'POST', `/centers/${center.id}/needs-fix`, {
      reason: 'پروانه ناخوانا',
    });
    expect(fix.body['status']).toBe('needs_fix');
    expect((await api(specialist, 'POST', `/centers/${center.id}/submit`, reason)).status).toBe(
      200,
    );
    const history = await h.owner.query(
      'SELECT from_status, to_status FROM center_status_changes WHERE center_id = $1 ORDER BY created_at',
      [center.id],
    );
    expect(history.rows).toEqual([
      { from_status: 'draft', to_status: 'under_review' },
      { from_status: 'under_review', to_status: 'needs_fix' },
      { from_status: 'needs_fix', to_status: 'under_review' },
    ]);
  });

  it('activation is proposed only with every document verified', async () => {
    const center = await newCenter(specialist);
    await receiveAll(specialist, center.id);
    await api(specialist, 'POST', `/centers/${center.id}/submit`, reason);
    const early = await api(managerA, 'POST', `/centers/${center.id}/activation-requests`, reason);
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('documents_not_verified');
  });

  it('the database refuses a transition outside doc 08 §3, and activation without a request', async () => {
    const center = await newCenter(specialist);
    await expect(
      app.query(`UPDATE centers SET status = 'active' WHERE id = $1`, [center.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await receiveAll(specialist, center.id);
    await api(specialist, 'POST', `/centers/${center.id}/submit`, reason);
    await expect(
      app.query(`UPDATE centers SET status = 'active', first_activated_at = now() WHERE id = $1`, [
        center.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(app.query('DELETE FROM centers WHERE id = $1', [center.id])).rejects.toBeTruthy();
  });
});

describe('ACCEPTANCE (doc 08 §15 test 8): activation and a Sheba change need two people', () => {
  it('the proposer cannot approve an activation, even holding network_manager', async () => {
    const center = await newCenter(specialist);
    await receiveAll(specialist, center.id);
    await api(specialist, 'POST', `/centers/${center.id}/submit`, reason);
    await receiveAll(specialist, center.id, 'verified');
    const proposed = await api(
      managerA,
      'POST',
      `/centers/${center.id}/activation-requests`,
      reason,
    );
    const requestId = proposed.body['id'] as string;

    const self = await api(managerA, 'POST', `/requests/${requestId}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('second_person_required');
    // The specialist lacks the approving permission.
    expect((await api(specialist, 'POST', `/requests/${requestId}/approve`, {})).status).toBe(403);
    // Not even the database lets the proposer decide.
    await expect(
      app.query(
        `UPDATE center_change_requests SET status = 'approved', decided_by = proposed_by, decided_at = now() WHERE id = $1`,
        [requestId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const approved = await api(managerB, 'POST', `/requests/${requestId}/approve`, {});
    expect(approved.status).toBe(200);
    const detail = await api(specialist, 'GET', `/centers/${center.id}`);
    expect(detail.body['status']).toBe('active');
    expect(await h.app.get<CenterDirectory>(CENTER_DIRECTORY).isBookable(center.nodeId)).toBe(true);
  });

  it('a new Sheba after activation: proposed by the center manager, approved only by accounting', async () => {
    const center = await activeCenter();
    const centerManager = await loggedInAccount(h, 'staff');
    await grantRole(h, centerManager.id, 'center_manager', {
      kind: 'center',
      nodeId: center.nodeId,
    });

    const direct = await api(centerManager, 'PATCH', `/centers/${center.id}`, {
      sheba: sheba(),
      accountHolderName: 'دیگری',
      ...reason,
    });
    expect(direct.status).toBe(409);
    expect(direct.body['error']).toBe('use_two_person_request');

    const next = sheba();
    const proposed = await api(
      centerManager,
      'POST',
      `/centers/${center.id}/bank-account-requests`,
      {
        sheba: next,
        accountHolderName: 'صاحب تازه',
        ...reason,
      },
    );
    expect(proposed.status).toBe(201);
    expect(JSON.stringify(proposed.body)).not.toContain(next.slice(2));
    const requestId = proposed.body['id'] as string;

    expect((await api(centerManager, 'POST', `/requests/${requestId}/approve`, {})).status).toBe(
      403,
    );
    expect((await api(managerB, 'POST', `/requests/${requestId}/approve`, {})).status).toBe(403);
    // A direct write of the new account is refused by the database.
    await expect(
      app.query(`UPDATE centers SET account_holder_name = 'دور زدن' WHERE id = $1`, [center.id]),
    ).rejects.toMatchObject({ code: '23514' });

    expect((await api(accountant, 'POST', `/requests/${requestId}/approve`, {})).status).toBe(200);
    const account = await api(accountant, 'GET', `/centers/${center.id}/bank-account`);
    expect(account.body).toEqual({ sheba: next, accountHolderName: 'صاحب تازه' });
    // Only accounting sees the full Sheba; the view is recorded.
    expect((await api(specialist, 'GET', `/centers/${center.id}/bank-account`)).status).toBe(403);
    const views = await h.owner.query(
      `SELECT count(*)::int AS n FROM access_logs WHERE entity_type = 'center_bank_account' AND entity_id = $1`,
      [center.id],
    );
    expect(views.rows[0]).toEqual({ n: 1 });
  });

  it('the same user cannot propose and approve a Sheba change, even with both permissions', async () => {
    const center = await activeCenter();
    const both = await loggedInAccount(h, 'staff');
    await grantRole(h, both.id, 'network_specialist');
    await grantRole(h, both.id, 'accounting');
    const proposed = await api(both, 'POST', `/centers/${center.id}/bank-account-requests`, {
      sheba: sheba(),
      accountHolderName: 'صاحب',
      ...reason,
    });
    const self = await api(both, 'POST', `/requests/${proposed.body['id'] as string}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('second_person_required');
  });
});

describe('suspension and termination (doc 08 §15 test 5, first half)', () => {
  it('a suspended center takes no new appointment and publishes catalog.center_suspended', async () => {
    const center = await activeCenter();
    const directory = h.app.get<CenterDirectory>(CENTER_DIRECTORY);
    const detail = await api(specialist, 'GET', `/centers/${center.id}`);
    const branchNode = (detail.body['branches'] as { nodeId: string }[])[0]?.nodeId ?? '';
    expect(await directory.isBookable(branchNode)).toBe(true);

    const suspended = await api(specialist, 'POST', `/centers/${center.id}/suspend`, {
      reason: 'تخلف',
    });
    expect(suspended.body['status']).toBe('suspended');
    expect(await directory.isBookable(center.nodeId)).toBe(false);
    expect(await directory.isBookable(branchNode)).toBe(false);
    const events = await h.owner.query(
      `SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at, id`,
      [center.id],
    );
    const payload = { centerId: center.id, centerNodeId: center.nodeId };
    expect(events.rows).toEqual([
      { event_type: 'catalog.center_submitted', payload },
      { event_type: 'catalog.center_activated', payload },
      { event_type: 'catalog.center_suspended', payload },
    ]);
    // Nothing was deleted.
    const { rows } = await h.owner.query('SELECT deleted_at FROM centers WHERE id = $1', [
      center.id,
    ]);
    expect(rows[0]).toEqual({ deleted_at: null });

    // Reactivation is two-person too.
    const proposed = await api(
      managerA,
      'POST',
      `/centers/${center.id}/activation-requests`,
      reason,
    );
    expect(proposed.body['kind']).toBe('reactivation');
    expect(
      (await api(managerA, 'POST', `/requests/${proposed.body['id'] as string}/approve`, {}))
        .status,
    ).toBe(403);
    expect(
      (await api(managerB, 'POST', `/requests/${proposed.body['id'] as string}/approve`, {}))
        .status,
    ).toBe(200);
    expect(await directory.isBookable(center.nodeId)).toBe(true);
  });

  // TODO(2-6): with the booking module, a suspended or terminated center's future
  // appointments move to the «needs relocation» queue and are never deleted (ADR-022).
  it.todo('future appointments of a suspended center go to the relocation queue, not deleted');

  it('a terminated center keeps blocking its IDs and cannot change', async () => {
    const id = nationalId();
    const center = await activeCenter(managerB, { identifier: id });
    await api(specialist, 'PATCH', `/centers/${center.id}`, { phone: '02133334444', ...reason });
    const open = await api(specialist, 'POST', `/centers/${center.id}/bank-account-requests`, {
      sheba: sheba(),
      accountHolderName: 'صاحب تازه',
      ...reason,
    });
    expect(open.status).toBe(201);
    const ended = await api(specialist, 'POST', `/centers/${center.id}/terminate`, {
      reason: 'پایان همکاری',
    });
    expect(ended.body['status']).toBe('terminated');
    const events = await h.owner.query(
      `SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at, id`,
      [center.id],
    );
    expect(events.rows.at(-1)).toEqual({ event_type: 'catalog.center_terminated' });
    // Its open request was withdrawn with it; nobody can approve it now.
    const late = await api(
      accountant,
      'POST',
      `/requests/${open.body['id'] as string}/approve`,
      {},
    );
    expect(late.status).toBe(409);
    expect(late.body['error']).toBe('already_decided');
    expect(await h.app.get<CenterDirectory>(CENTER_DIRECTORY).isBookable(center.nodeId)).toBe(
      false,
    );
    expect(
      (await api(specialist, 'PATCH', `/centers/${center.id}`, { phone: '02155556666', ...reason }))
        .status,
    ).toBe(409);
    const again = await api(specialist, 'POST', '/centers', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'natural',
      identifier: id,
      name: 'تکرار',
      cityCode: 'tehran',
    });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('duplicate_identifier');
    // Neither soft-deleting it (which would free the ID) nor any other change gets past
    // the database.
    await expect(
      app.query('UPDATE centers SET deleted_at = now() WHERE id = $1', [center.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query(`UPDATE centers SET phone = '02100001111' WHERE id = $1`, [center.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('scopes (rule 13)', () => {
  it('a center manager sees only their center; a branch manager edits only their branch', async () => {
    const mine = await newCenter(specialist);
    const theirs = await newCenter(specialist);
    const centerManager = await loggedInAccount(h, 'staff');
    await grantRole(h, centerManager.id, 'center_manager', { kind: 'center', nodeId: mine.nodeId });
    expect((await api(centerManager, 'GET', `/centers/${mine.id}`)).status).toBe(200);
    expect((await api(centerManager, 'GET', `/centers/${theirs.id}`)).status).toBe(404);
    expect(
      (
        await api(centerManager, 'PATCH', `/centers/${theirs.id}`, {
          phone: '02100000000',
          ...reason,
        })
      ).status,
    ).toBe(404);
    // The center manager cannot review or activate their own center.
    expect((await api(centerManager, 'POST', `/centers/${mine.id}/needs-fix`, reason)).status).toBe(
      403,
    );

    const second = await api(specialist, 'POST', `/centers/${mine.id}/branches`, {
      name: 'شعبه دوم',
      parking: 'limited',
      nearestMetro: 'ایستگاه آزمون',
      ...reason,
    });
    expect(second.status).toBe(201);
    const detail = await api(specialist, 'GET', `/centers/${mine.id}`);
    const [first] = detail.body['branches'] as { id: string; nodeId: string; isDefault: boolean }[];
    const branchManager = await loggedInAccount(h, 'staff');
    await grantRole(h, branchManager.id, 'center_manager', {
      kind: 'branch',
      nodeId: second.body['nodeId'] as string,
    });
    const own = await api(branchManager, 'PATCH', `/branches/${second.body['id'] as string}`, {
      routeNote: 'ورودی از خیابان فرعی',
      ...reason,
    });
    expect(own.status).toBe(200);
    expect(own.body['routeNote']).toBe('ورودی از خیابان فرعی');
    expect(
      (
        await api(branchManager, 'PATCH', `/branches/${first?.id ?? ''}`, {
          routeNote: 'نه',
          ...reason,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(branchManager, 'PATCH', `/centers/${mine.id}`, {
          phone: '02100000000',
          ...reason,
        })
      ).status,
    ).toBe(403);
  });
});

describe('review gaps closed after the power cut (task 2-2 review)', () => {
  /** A center under review with every document verified. */
  async function reviewedCenter() {
    const center = await newCenter(specialist);
    await receiveAll(specialist, center.id);
    expect((await api(specialist, 'POST', `/centers/${center.id}/submit`, reason)).status).toBe(
      200,
    );
    await receiveAll(specialist, center.id, 'verified');
    return center;
  }

  it('sending back for a fix withdraws the open activation; the old one can never be approved', async () => {
    const center = await reviewedCenter();
    const stale = await api(
      specialist,
      'POST',
      `/centers/${center.id}/activation-requests`,
      reason,
    );
    expect(stale.status).toBe(201);
    await api(managerA, 'POST', `/centers/${center.id}/needs-fix`, { reason: 'مغایرت نشانی' });
    await receiveAll(specialist, center.id);
    await api(specialist, 'POST', `/centers/${center.id}/submit`, reason);
    await receiveAll(specialist, center.id, 'verified');

    const old = await api(managerB, 'POST', `/requests/${stale.body['id'] as string}/approve`, {});
    expect(old.status).toBe(409);
    expect(old.body['error']).toBe('already_decided');
    const { rows } = await h.owner.query(
      'SELECT status, decided_by FROM center_change_requests WHERE id = $1',
      [stale.body['id']],
    );
    expect(rows[0]).toEqual({ status: 'withdrawn', decided_by: managerA.id });

    const fresh = await api(
      specialist,
      'POST',
      `/centers/${center.id}/activation-requests`,
      reason,
    );
    expect(fresh.status).toBe(201);
    const approved = await api(
      managerB,
      'POST',
      `/requests/${fresh.body['id'] as string}/approve`,
      {},
    );
    expect(approved.status).toBe(200);
  });

  it('approval checks the documents again: one marked incomplete after the proposal stops it', async () => {
    const center = await reviewedCenter();
    const proposed = await api(
      specialist,
      'POST',
      `/centers/${center.id}/activation-requests`,
      reason,
    );
    const detail = await api(specialist, 'GET', `/centers/${center.id}`);
    const [first] = detail.body['documents'] as { code: string }[];
    await api(specialist, 'PUT', `/centers/${center.id}/documents/${first?.code ?? ''}`, {
      status: 'incomplete',
    });
    const approve = await api(
      managerB,
      'POST',
      `/requests/${proposed.body['id'] as string}/approve`,
      {},
    );
    expect(approve.status).toBe(409);
    expect(approve.body['error']).toBe('documents_not_verified');
  });

  it('the database: a request is never written pre-approved, and is decided only once', async () => {
    const center = await reviewedCenter();
    await expect(
      app.query(
        `INSERT INTO center_change_requests (center_id, kind, status, reason, proposed_by, decided_by, decided_at)
         VALUES ($1, 'activation', 'approved', 'دور زدن', $2, $3, now())`,
        [center.id, managerA.id, managerB.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const proposed = await api(
      specialist,
      'POST',
      `/centers/${center.id}/activation-requests`,
      reason,
    );
    const requestId = proposed.body['id'] as string;
    await api(managerB, 'POST', `/requests/${requestId}/reject`, { note: 'نه هنوز' });
    await expect(
      app.query(
        `UPDATE center_change_requests SET status = 'approved', decided_by = $2 WHERE id = $1`,
        [requestId, managerA.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the database: under review, identity and bank account are fixed; only a draft is soft-deleted', async () => {
    const center = await reviewedCenter();
    await expect(
      app.query(`UPDATE centers SET account_holder_name = 'دیگری' WHERE id = $1`, [center.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query('UPDATE centers SET deleted_at = now() WHERE id = $1', [center.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query('UPDATE centers SET first_activated_at = now() WHERE id = $1', [center.id]),
    ).rejects.toMatchObject({ code: '23514' });

    const draft = await newCenter(specialist);
    await app.query('UPDATE centers SET deleted_at = now() WHERE id = $1', [draft.id]);
    await expect(
      app.query('UPDATE centers SET deleted_at = NULL WHERE id = $1', [draft.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a request of a center outside the approver’s scope does not exist (404)', async () => {
    const center = await reviewedCenter();
    const proposed = await api(
      specialist,
      'POST',
      `/centers/${center.id}/activation-requests`,
      reason,
    );
    const shirazManager = await loggedInAccount(h, 'staff');
    await grantRole(h, shirazManager.id, 'network_manager', { kind: 'city', code: 'shiraz' });
    const res = await api(
      shirazManager,
      'POST',
      `/requests/${proposed.body['id'] as string}/approve`,
      {},
    );
    expect(res.status).toBe(404);
    expect(res.body['error']).toBe('request_not_found');
  });

  it('a branch manager sees their own branch, not the other branches, documents, requests or bank account', async () => {
    const center = await reviewedCenter();
    await api(specialist, 'POST', `/centers/${center.id}/activation-requests`, reason);
    const second = await api(specialist, 'POST', `/centers/${center.id}/branches`, {
      name: 'شعبه غرب',
      ...reason,
    });
    const branchManager = await loggedInAccount(h, 'staff');
    await grantRole(h, branchManager.id, 'center_manager', {
      kind: 'branch',
      nodeId: second.body['nodeId'] as string,
    });

    const view = await api(branchManager, 'GET', `/centers/${center.id}`);
    expect(view.status).toBe(200);
    expect((view.body['branches'] as { id: string }[]).map((b) => b.id)).toEqual([
      second.body['id'],
    ]);
    expect(view.body).toMatchObject({
      documents: [],
      requests: [],
      shebaLast4: null,
      accountHolderName: null,
    });
    const list = await api(branchManager, 'GET', '/centers');
    const listed = (list.body as unknown as { id: string; shebaLast4: string | null }[]).find(
      (c) => c.id === center.id,
    );
    expect(listed?.shebaLast4).toBeNull();
    const requests = await api(branchManager, 'GET', '/requests');
    expect(requests.body).toEqual([]);
  });
});
