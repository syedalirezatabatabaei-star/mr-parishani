import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionCode } from '@sepehr/contracts';
import { TARIFF_BOOK, type TariffBook } from '../../src/common/catalog/tariff-book.port';
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
import { councilNumber, nationalId, sheba } from './fixtures';

let h: Harness;
let book: TariffBook;
let specialist: LoggedInAccount;
let networkManager: LoggedInAccount;
let approver: LoggedInAccount;
let admin: LoggedInAccount;

type Body = Record<string, unknown>;
const api = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

const reason = { reason: 'آزمون تعرفه' };

interface Center {
  id: string;
  nodeId: string;
  branchId: string;
  branchNodeId: string;
}

/** A center (in the dental field) taken through review to an approved activation. */
async function activeCenter(): Promise<Center> {
  const created = await api(specialist, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: 'کلینیک تعرفه',
    cityCode: 'tehran',
    sheba: sheba(),
    accountHolderName: 'صاحب حساب',
    treatmentFieldCodes: ['dental'],
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
    approver,
    'POST',
    `/catalog/requests/${proposed.body['id'] as string}/approve`,
    {},
  );
  expect(approved.status).toBe(200);
  const detail = await api(specialist, 'GET', `/catalog/centers/${id}`);
  const [branch] = detail.body['branches'] as { id: string; nodeId: string }[];
  return {
    id,
    nodeId: created.body['nodeId'] as string,
    branchId: branch?.id ?? '',
    branchNodeId: branch?.nodeId ?? '',
  };
}

/** A dentist at `branchId`, optionally with an account; returns the profile and workplace. */
async function dentist(branchId: string, withAccount = false) {
  const res = await api(specialist, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: 'دکتر دندان',
    medicalCouncilNumber: councilNumber(),
    treatmentFieldCodes: ['dental'],
    workplace: { kind: 'branch', branchId },
    ...reason,
  });
  expect(res.status).toBe(201);
  const id = res.body['id'] as string;
  let account: LoggedInAccount | null = null;
  if (withAccount) {
    account = await loggedInAccount(h, 'center');
    const linked = await api(specialist, 'POST', `/catalog/doctors/${id}/account`, {
      accountId: account.id,
      ...reason,
    });
    expect(linked.status).toBe(201);
  }
  const detail = await api(specialist, 'GET', `/catalog/doctors/${id}`);
  const [workplace] = detail.body['workplaces'] as { id: string; nodeId: string }[];
  return { id, account, workplaceId: workplace?.id ?? '', nodeId: workplace?.nodeId ?? '' };
}

async function centerManagerOf(center: Center) {
  const manager = await loggedInAccount(h, 'center');
  await grantRole(h, manager.id, 'center_manager', { kind: 'center', nodeId: center.nodeId });
  return manager;
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

async function customRole(permissions: PermissionCode[]) {
  const code = `sec_${Math.random().toString(36).slice(2, 10)}`;
  await h.app
    .get(AccessService)
    .createRole(CLI_ACTOR, { code, name: 'نقش منشی', permissions, reason: 'test fixture' });
  return code;
}

const range = (minRial: string, maxRial: string) => ({ kind: 'range', minRial, maxRial });

function setPrice(
  who: LoggedInAccount,
  owner: Body,
  serviceCode: string,
  pricing: Body,
  extra: Body = {},
) {
  return api(who, 'POST', '/catalog/tariffs', { owner, serviceCode, pricing, ...reason, ...extra });
}

const atWorkplace = (workplaceId: string) => ({ kind: 'workplace', workplaceId });

beforeAll(async () => {
  h = await startHarness();
  book = h.app.get<TariffBook>(TARIFF_BOOK);
  [specialist, networkManager, approver, admin] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, networkManager.id, 'network_manager');
  await grantRole(h, approver.id, 'network_manager');
  await grantRole(h, admin.id, 'system_admin');

  const field = await api(networkManager, 'POST', '/catalog/fields', {
    code: 'dental',
    name: 'دندانپزشکی',
    ...reason,
  });
  expect(field.status).toBe(201);
  for (const [code, name] of [
    ['implant', 'ایمپلنت'],
    ['root_canal', 'عصب‌کشی'],
  ] as const) {
    const created = await api(networkManager, 'POST', '/catalog/services', {
      fieldCode: 'dental',
      code,
      name,
      ...reason,
    });
    expect(created.status).toBe(201);
  }
  await api(admin, 'POST', '/catalog/fields', { code: 'eye', name: 'چشم‌پزشکی', ...reason });
  await api(admin, 'POST', '/catalog/services', {
    fieldCode: 'eye',
    code: 'lasik',
    name: 'لیزیک',
    ...reason,
  });
});

afterAll(async () => {
  await h.close();
});

describe('treatment fields and services', () => {
  it('are listed publicly; only the network manager and the system admin change them', async () => {
    const fields = await call(h, 'GET', '/catalog/fields');
    expect(fields.status).toBe(200);
    expect((fields.body as unknown as { code: string }[]).map((f) => f.code)).toEqual(
      expect.arrayContaining(['dental', 'eye']),
    );
    const dentalServices = await call(h, 'GET', '/catalog/services?fieldCode=dental');
    expect((dentalServices.body as unknown as { code: string }[]).map((s) => s.code)).toEqual([
      'visit',
      'implant',
      'root_canal',
    ]);

    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    for (const who of [specialist, manager]) {
      const refused = await api(who, 'POST', '/catalog/services', {
        fieldCode: 'dental',
        code: 'whitening',
        name: 'سفیدکردن',
        ...reason,
      });
      expect(refused.status).toBe(403);
    }
    const again = await api(networkManager, 'POST', '/catalog/fields', {
      code: 'dental',
      name: 'دندان دوم',
      ...reason,
    });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('duplicate_code');

    const audit = await h.owner.query(
      `SELECT actor_account_id FROM audit_events WHERE action = 'catalog.treatment_field_created'`,
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('the visit belongs to no field and is never retired', async () => {
    const all = await call(h, 'GET', '/catalog/services');
    const visit = (all.body as unknown as { code: string; kind: string; fieldCode: unknown }[])[0];
    // ADR-050: every service is the doctor's wage unless set otherwise.
    expect(visit).toEqual({
      code: 'visit',
      name: 'ویزیت',
      kind: 'visit',
      costKind: 'wage',
      fieldCode: null,
    });
    const retire = await api(networkManager, 'POST', '/catalog/services/visit/retire', reason);
    expect(retire.status).toBe(409);
    await expect(
      h.owner.query(`UPDATE services SET deleted_at = now() WHERE code = 'visit'`),
    ).rejects.toThrow(/cannot be retired/);
  });

  it('centers and doctors pick only active fields of the catalog', async () => {
    await api(networkManager, 'POST', '/catalog/fields', {
      code: 'old_field',
      name: 'فیلد قدیمی',
      ...reason,
    });
    const retired = await api(networkManager, 'POST', '/catalog/fields/old_field/retire', reason);
    expect(retired.status).toBe(201);
    const listed = await call(h, 'GET', '/catalog/fields');
    expect((listed.body as unknown as { code: string }[]).map((f) => f.code)).not.toContain(
      'old_field',
    );
    for (const codes of [['old_field'], ['no_such_field']]) {
      const res = await api(specialist, 'POST', '/catalog/centers', {
        // Owner 1405/07/27: the registration form requires the contract term.
        contractTerm: { startsOn: '2026-10-01', months: 12 },
        personType: 'natural',
        identifier: nationalId(),
        name: 'مرکز فیلد',
        cityCode: 'tehran',
        treatmentFieldCodes: codes,
      });
      expect(res.status).toBe(400);
      expect(res.body['error']).toBe('unknown_treatment_field');
    }
    // A retired code is never reused.
    const reuse = await api(networkManager, 'POST', '/catalog/fields', {
      code: 'old_field',
      name: 'فیلد تازه',
      ...reason,
    });
    expect(reuse.status).toBe(409);
  });
});

describe('doc 08 §15 test 4: a tariff change does not reach an earlier booking', () => {
  it('the quoted version and any past moment keep their price', async () => {
    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);

    const first = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('150000000', '250000000'),
    );
    expect(first.status).toBe(201);
    const booked = await book.quote(doctor.workplaceId, 'implant', new Date());
    expect(booked).toMatchObject({
      source: 'workplace',
      minAmountRial: 150_000_000n,
      maxAmountRial: 250_000_000n,
      isFree: false,
    });
    // What an appointment will keep (task 2-6): the version id.
    const bookedVersionId = booked?.tariffVersionId ?? '';

    const changed = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('180000000', '300000000'),
    );
    expect(changed.status).toBe(201);

    // The booking's version is unchanged, and so is the price at the moment it was quoted.
    expect(await book.version(bookedVersionId)).toEqual(booked);
    expect(
      await book.quote(doctor.workplaceId, 'implant', booked?.effectiveAt ?? new Date()),
    ).toEqual(booked);
    const now = await book.quote(doctor.workplaceId, 'implant', new Date());
    expect(now?.tariffVersionId).not.toBe(bookedVersionId);
    expect(now).toMatchObject({ minAmountRial: 180_000_000n, maxAmountRial: 300_000_000n });

    // Not even the schema owner edits or deletes a started version.
    await expect(
      h.owner.query('UPDATE tariff_versions SET min_amount_rial = 1 WHERE id = $1', [
        bookedVersionId,
      ]),
    ).rejects.toThrow(/has started/);
    await expect(
      h.owner.query('DELETE FROM tariff_versions WHERE id = $1', [bookedVersionId]),
    ).rejects.toThrow();
    await expect(
      h.owner.query(`UPDATE tariffs SET city_code = 'shiraz' WHERE id = $1`, [booked?.tariffId]),
    ).rejects.toThrow();
  });

  // An appointment keeping its tariff version after the price changes (doc 08 §15 test 4)
  // is tested with the appointments: test/booking/appointments.int.test.ts (task 2-6).
});

describe('prices', () => {
  it('are whole rials as bigint, beyond 2^53 without loss; min <= max', async () => {
    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);
    const huge = '900000000000000001';
    const res = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'root_canal',
      range(huge, huge),
    );
    expect(res.status).toBe(201);
    expect((res.body['current'] as Body)['minAmountRial']).toBe(huge);
    const stored = await h.owner.query(
      `SELECT min_amount_rial::text AS min FROM tariff_versions WHERE id = $1`,
      [(res.body['current'] as Body)['id']],
    );
    expect(stored.rows[0]).toEqual({ min: huge });
    expect((await book.quote(doctor.workplaceId, 'root_canal', new Date()))?.minAmountRial).toBe(
      900_000_000_000_000_001n,
    );

    const inverted = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'root_canal',
      range('20', '10'),
    );
    expect(inverted.status).toBe(400);
    const fraction = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'root_canal',
      range('10.5', '20'),
    );
    expect(fraction.status).toBe(400);
  });

  it('only the visit may be free, in the service and in the database', async () => {
    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);
    const free = await setPrice(manager, atWorkplace(doctor.workplaceId), 'visit', {
      kind: 'free',
    });
    expect(free.status).toBe(201);
    expect(await book.quote(doctor.workplaceId, 'visit', new Date())).toMatchObject({
      isFree: true,
      minAmountRial: 0n,
      maxAmountRial: 0n,
    });
    const paid = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'visit',
      range('5000000', '5000000'),
    );
    expect(paid.status).toBe(201);
    expect((await book.quote(doctor.workplaceId, 'visit', new Date()))?.isFree).toBe(false);

    const refused = await setPrice(manager, atWorkplace(doctor.workplaceId), 'implant', {
      kind: 'free',
    });
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('only_visit_can_be_free');
    const implant = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('10', '20'),
    );
    await expect(
      h.owner.query(
        `INSERT INTO tariff_versions (tariff_id, status, is_free, min_amount_rial, max_amount_rial, effective_at, reason)
         VALUES ($1, 'offered', true, 0, 0, now() + interval '1 day', 'دور زدن')`,
        [implant.body['id']],
      ),
    ).rejects.toThrow(/only the visit/);
  });

  it('a service outside the owner’s fields, or retired, takes no price', async () => {
    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);
    const eye = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'lasik',
      range('10', '20'),
    );
    expect(eye.status).toBe(409);
    expect(eye.body['error']).toBe('service_outside_fields');
    const centerEye = await setPrice(
      manager,
      { kind: 'center', centerId: center.id },
      'lasik',
      range('10', '20'),
    );
    expect(centerEye.status).toBe(409);

    await api(networkManager, 'POST', '/catalog/services', {
      fieldCode: 'dental',
      code: 'bridge',
      name: 'بریج',
      ...reason,
    });
    const priced = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'bridge',
      range('10', '20'),
    );
    expect(priced.status).toBe(201);
    await api(networkManager, 'POST', '/catalog/services/bridge/retire', reason);
    expect(await book.quote(doctor.workplaceId, 'bridge', new Date())).toBeNull();
    const after = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'bridge',
      range('10', '20'),
    );
    expect(after.status).toBe(404);
  });
});

describe('the workplace wins over its center', () => {
  it('falls back to the center only while the workplace has no version in force', async () => {
    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);

    expect(await book.quote(doctor.workplaceId, 'implant', new Date())).toBeNull();
    const centerPrice = await setPrice(
      manager,
      { kind: 'center', centerId: center.id },
      'implant',
      range('100', '200'),
    );
    expect(centerPrice.status).toBe(201);
    expect(await book.quote(doctor.workplaceId, 'implant', new Date())).toMatchObject({
      source: 'center',
      minAmountRial: 100n,
    });

    // A workplace version still to come does not hide the center's yet.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await setPrice(manager, atWorkplace(doctor.workplaceId), 'implant', range('300', '400'), {
      effectiveAt: future,
    });
    expect((await book.quote(doctor.workplaceId, 'implant', new Date()))?.source).toBe('center');
    expect(await book.quote(doctor.workplaceId, 'implant', new Date(future))).toMatchObject({
      source: 'workplace',
      minAmountRial: 300n,
    });

    const own = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('500', '600'),
    );
    expect((await book.quote(doctor.workplaceId, 'implant', new Date()))?.minAmountRial).toBe(500n);

    // Withdrawn at the workplace: not offered, whatever the center says.
    const withdrawn = await api(
      manager,
      'POST',
      `/catalog/tariffs/${own.body['id'] as string}/withdraw`,
      reason,
    );
    expect(withdrawn.status).toBe(201);
    expect(await book.quote(doctor.workplaceId, 'implant', new Date())).toBeNull();

    const quoted = await api(
      manager,
      'GET',
      `/catalog/workplaces/${doctor.workplaceId}/quote?serviceCode=implant`,
    );
    expect(quoted.body).toEqual({ quote: null });
  });
});

describe('versions', () => {
  it('a version not started may be cancelled; a started one never; none starts in the past', async () => {
    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);
    const started = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('100', '200'),
    );
    const tariffId = started.body['id'] as string;
    const startedId = (started.body['current'] as Body)['id'] as string;

    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const planned = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('300', '400'),
      {
        effectiveAt: future,
      },
    );
    const upcoming = planned.body['upcoming'] as Body[];
    expect(upcoming).toHaveLength(1);
    const plannedId = upcoming[0]?.['id'] as string;

    const cancelled = await api(
      manager,
      'POST',
      `/catalog/tariff-versions/${plannedId}/cancel`,
      reason,
    );
    expect(cancelled.status).toBe(201);
    expect(cancelled.body['upcoming']).toEqual([]);
    expect((await book.quote(doctor.workplaceId, 'implant', new Date(future)))?.minAmountRial).toBe(
      100n,
    );
    const twice = await api(
      manager,
      'POST',
      `/catalog/tariff-versions/${plannedId}/cancel`,
      reason,
    );
    expect(twice.status).toBe(409);

    const refused = await api(
      manager,
      'POST',
      `/catalog/tariff-versions/${startedId}/cancel`,
      reason,
    );
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('tariff_version_started');

    const past = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('1', '2'),
      {
        effectiveAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    );
    expect(past.status).toBe(400);
    expect(past.body['error']).toBe('effective_in_past');

    const history = await api(manager, 'GET', `/catalog/tariffs/${tariffId}`);
    const versions = history.body['history'] as Body[];
    expect(versions.map((v) => v['cancelledAt'] !== null)).toEqual([false, true]);
  });
});

describe('who changes a price (task 2-4 decisions)', () => {
  it('the network specialist only reads the price of a center’s doctor', async () => {
    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);
    await setPrice(manager, atWorkplace(doctor.workplaceId), 'implant', range('100', '200'));

    const read = await api(specialist, 'GET', `/catalog/tariffs?workplaceId=${doctor.workplaceId}`);
    expect(read.status).toBe(200);
    expect(read.body as unknown as unknown[]).toHaveLength(1);
    const write = await setPrice(
      specialist,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('1', '2'),
    );
    expect(write.status).toBe(403);
    // Not through the private-practice path either, though the doctor has no account.
    const viaNetwork = await api(specialist, 'POST', '/catalog/network/tariffs', {
      owner: atWorkplace(doctor.workplaceId),
      serviceCode: 'implant',
      pricing: range('1', '2'),
      ...reason,
    });
    expect(viaNetwork.status).toBe(403);
    expect(viaNetwork.body['error']).toBe('private_practice_only');
  });

  it('a branch manager for the doctors of their own branch only, never the center’s own tariff', async () => {
    const center = await activeCenter();
    const added = await api(specialist, 'POST', `/catalog/centers/${center.id}/branches`, {
      name: 'شعبه دوم',
      ...reason,
    });
    expect(added.status).toBe(201);
    const detail = await api(specialist, 'GET', `/catalog/centers/${center.id}`);
    const second = (detail.body['branches'] as { id: string; nodeId: string }[]).find(
      (b) => b.id !== center.branchId,
    );
    const mine = await dentist(center.branchId);
    const theirs = await dentist(second?.id ?? '');

    const branchManager = await loggedInAccount(h, 'center');
    await grantRole(h, branchManager.id, 'center_manager', {
      kind: 'branch',
      nodeId: center.branchNodeId,
    });
    const own = await setPrice(
      branchManager,
      atWorkplace(mine.workplaceId),
      'implant',
      range('100', '200'),
    );
    expect(own.status).toBe(201);
    const audit = await h.owner.query(
      `SELECT actor_account_id, on_behalf_of_doctor_id FROM audit_events
       WHERE action = 'catalog.tariff_set' AND entity_id = $1`,
      [own.body['id']],
    );
    expect(audit.rows).toEqual([
      { actor_account_id: branchManager.id, on_behalf_of_doctor_id: mine.id },
    ]);

    // The other branch does not exist for them; the center's own tariff is the center manager's.
    const other = await setPrice(
      branchManager,
      atWorkplace(theirs.workplaceId),
      'implant',
      range('1', '2'),
    );
    expect(other.status).toBe(404);
    const centerByBranch = await setPrice(
      branchManager,
      { kind: 'center', centerId: center.id },
      'implant',
      range('1', '2'),
    );
    expect(centerByBranch.status).toBe(403);
    expect(centerByBranch.body['error']).toBe('tariff_managers_only');
  });

  it('the network specialist for a private practice whose doctor has no account, until they get one', async () => {
    const setByNetwork = (who: LoggedInAccount, workplaceId: string, body: Body = reason) =>
      api(who, 'POST', '/catalog/network/tariffs', {
        owner: atWorkplace(workplaceId),
        serviceCode: 'visit',
        pricing: range('4000000', '6000000'),
        ...body,
      });
    const registered = await api(specialist, 'POST', '/catalog/doctors', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      name: 'دکتر مطب',
      medicalCouncilNumber: councilNumber(),
      treatmentFieldCodes: ['dental'],
      workplace: { kind: 'private_practice', cityCode: 'tehran' },
      ...reason,
    });
    expect(registered.status).toBe(201);
    const doctorId = registered.body['id'] as string;
    const detail = await api(specialist, 'GET', `/catalog/doctors/${doctorId}`);
    const [workplace] = detail.body['workplaces'] as { id: string }[];
    const workplaceId = workplace?.id ?? '';

    // The ordinary path stays closed to the network.
    expect(
      (await setPrice(specialist, atWorkplace(workplaceId), 'visit', range('1', '2'))).status,
    ).toBe(403);
    // The reason is required.
    expect((await setByNetwork(specialist, workplaceId, {})).status).toBe(400);

    const set = await setByNetwork(specialist, workplaceId);
    expect(set.status).toBe(201);
    const audit = await h.owner.query(
      `SELECT actor_account_id, on_behalf_of_doctor_id, reason FROM audit_events
       WHERE action = 'catalog.tariff_set' AND entity_id = $1`,
      [set.body['id']],
    );
    expect(audit.rows).toEqual([
      { actor_account_id: specialist.id, on_behalf_of_doctor_id: doctorId, reason: reason.reason },
    ]);
    expect((await book.quote(workplaceId, 'visit', new Date()))?.minAmountRial).toBe(4_000_000n);

    // A specialist of another city: the practice does not exist for them.
    const shiraz = await loggedInAccount(h, 'staff');
    await grantRole(h, shiraz.id, 'network_specialist', { kind: 'city', code: 'shiraz' });
    expect((await setByNetwork(shiraz, workplaceId)).status).toBe(404);

    // Once the doctor has an account, the doctor decides and the network no longer may.
    const account = await loggedInAccount(h, 'center');
    await api(specialist, 'POST', `/catalog/doctors/${doctorId}/account`, {
      accountId: account.id,
      ...reason,
    });
    const refused = await setByNetwork(specialist, workplaceId);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('doctor_has_account');
    const withdraw = await api(
      specialist,
      'POST',
      `/catalog/network/tariffs/${set.body['id'] as string}/withdraw`,
      reason,
    );
    expect(withdraw.status).toBe(409);
    expect(
      (await setPrice(account, atWorkplace(workplaceId), 'visit', range('5000000', '7000000')))
        .status,
    ).toBe(201);
  });

  it('the center manager for the center and its doctors, on the doctor’s behalf; another center gets 404', async () => {
    const center = await activeCenter();
    const other = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);
    const res = await setPrice(
      manager,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('100', '200'),
    );
    expect(res.status).toBe(201);
    const audit = await h.owner.query(
      `SELECT actor_account_id, on_behalf_of_doctor_id FROM audit_events
       WHERE action = 'catalog.tariff_set' AND entity_id = $1`,
      [res.body['id']],
    );
    expect(audit.rows).toEqual([
      { actor_account_id: manager.id, on_behalf_of_doctor_id: doctor.id },
    ]);

    const otherDoctor = await dentist(other.branchId);
    const foreign = await setPrice(
      manager,
      atWorkplace(otherDoctor.workplaceId),
      'implant',
      range('1', '2'),
    );
    expect(foreign.status).toBe(404);
    const foreignCenter = await setPrice(
      manager,
      { kind: 'center', centerId: other.id },
      'implant',
      range('1', '2'),
    );
    expect(foreignCenter.status).toBe(404);
  });

  it('the doctor for their own workplace only; doctor A never sees doctor B’s', async () => {
    const center = await activeCenter();
    const a = await dentist(center.branchId, true);
    const b = await dentist(center.branchId, true);
    const doctorA = a.account as LoggedInAccount;

    const own = await setPrice(doctorA, atWorkplace(a.workplaceId), 'implant', range('100', '200'));
    expect(own.status).toBe(201);
    const audit = await h.owner.query(
      `SELECT actor_account_id, on_behalf_of_doctor_id FROM audit_events
       WHERE action = 'catalog.tariff_set' AND entity_id = $1`,
      [own.body['id']],
    );
    expect(audit.rows).toEqual([{ actor_account_id: doctorA.id, on_behalf_of_doctor_id: null }]);

    expect(
      (await setPrice(doctorA, atWorkplace(b.workplaceId), 'implant', range('1', '2'))).status,
    ).toBe(404);
    expect(
      (await api(doctorA, 'GET', `/catalog/tariffs?workplaceId=${b.workplaceId}`)).status,
    ).toBe(404);
    const bPrice = await setPrice(
      b.account as LoggedInAccount,
      atWorkplace(b.workplaceId),
      'implant',
      range('1', '2'),
    );
    expect(
      (await api(doctorA, 'GET', `/catalog/tariffs/${bPrice.body['id'] as string}`)).status,
    ).toBe(404);
    expect(
      (await setPrice(doctorA, { kind: 'center', centerId: center.id }, 'implant', range('1', '2')))
        .status,
    ).toBe(404);
  });

  it('a secretary only with what their own doctor delegated, on the doctor’s behalf', async () => {
    const center = await activeCenter();
    const a = await dentist(center.branchId, true);
    const b = await dentist(center.branchId, true);
    const doctorA = a.account as LoggedInAccount;
    const { account: secretary, secretary: node } = await newSecretary(doctorA, a.workplaceId);

    const before = await setPrice(
      secretary,
      atWorkplace(a.workplaceId),
      'implant',
      range('100', '200'),
    );
    expect(before.status).toBe(403);

    const role = await customRole(['catalog.read_tariffs', 'catalog.manage_tariffs']);
    const granted = await api(doctorA, 'POST', `/access/org-nodes/${node.nodeId}/assignments`, {
      roleCode: role,
      ...reason,
    });
    expect(granted.status).toBe(201);

    const res = await setPrice(
      secretary,
      atWorkplace(a.workplaceId),
      'implant',
      range('100', '200'),
    );
    expect(res.status).toBe(201);
    const audit = await h.owner.query(
      `SELECT actor_account_id, on_behalf_of_doctor_id FROM audit_events
       WHERE action = 'catalog.tariff_set' AND entity_id = $1`,
      [res.body['id']],
    );
    expect(audit.rows).toEqual([{ actor_account_id: secretary.id, on_behalf_of_doctor_id: a.id }]);

    // Another doctor's workplace, even with its id: it does not exist.
    expect(
      (await setPrice(secretary, atWorkplace(b.workplaceId), 'implant', range('1', '2'))).status,
    ).toBe(404);
    expect(
      (await api(secretary, 'GET', `/catalog/tariffs?workplaceId=${b.workplaceId}`)).status,
    ).toBe(404);
  });

  it('never through the center manager’s delegation for a doctor without an account', async () => {
    const center = await activeCenter();
    const manager = await centerManagerOf(center);
    const doctor = await dentist(center.branchId);
    const { account: secretary, secretary: node } = await newSecretary(manager, doctor.workplaceId);
    const role = await customRole(['catalog.read_tariffs', 'catalog.manage_tariffs']);
    const delegated = await api(manager, 'POST', `/catalog/secretaries/${node.id}/assignments`, {
      roleCode: role,
      ...reason,
    });
    expect(delegated.status).toBe(201);

    const res = await setPrice(
      secretary,
      atWorkplace(doctor.workplaceId),
      'implant',
      range('100', '200'),
    );
    expect(res.status).toBe(403);
    expect(res.body['error']).toBe('doctor_delegation_required');
    // Reading is what was delegated.
    expect(
      (await api(secretary, 'GET', `/catalog/tariffs?workplaceId=${doctor.workplaceId}`)).status,
    ).toBe(200);
  });
});
