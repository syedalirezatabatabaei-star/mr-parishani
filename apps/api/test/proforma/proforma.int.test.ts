import type { PermissionCode } from '@sepehr/contracts';
import { fromJalali, nextJalaliDay, toJalali, type JalaliDate } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { AccessService } from '../../src/modules/access/access.service';
import { ProformaService } from '../../src/modules/proforma/proforma.service';
import { examineAppointment } from '../booking/examine';
import { councilNumber, nationalId, sheba } from '../catalog/fixtures';
import {
  call,
  grantRole,
  loggedInAccount,
  newIp,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * Task 3-4 (doc 10 §2): proformas. Acceptance: doc 10 §10 tests 3 (an issued line is never
 * edited; a correction is a new version) and 4 (a tariff change after issue leaves the
 * proforma alone), and IDOR: doctor A never sees doctor B's patient's proforma. Only for a
 * patient referred to the same doctor through an appointment (owner, 1405/07/10).
 */

let h: Harness;
let specialist: LoggedInAccount;
let otherCitySpecialist: LoggedInAccount;
let networkManager: LoggedInAccount;
let approver: LoggedInAccount;

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const reason = { reason: 'آزمون پیش‌فاکتور' };
const staff = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

interface Patient {
  id: string;
  token: string;
}
async function patient(): Promise<Patient> {
  const mobile = newMobile();
  const login = await otpLogin(h, mobile, 'mobile', { ip: newIp() });
  expect(login.status).toBe(200);
  const { rows } = await h.owner.query<Row>('SELECT id FROM user_accounts WHERE mobile = $1', [
    mobile,
  ]);
  return { id: rows[0]?.['id'] as string, token: login.body['accessToken'] as string };
}
const as = (p: Patient, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: p.token, ...(body === undefined ? {} : { body }) });

function dayAhead(days: number): JalaliDate {
  let date = toJalali(new Date());
  for (let i = 0; i < days; i++) date = nextJalaliDay(date);
  return date;
}

interface Doctor {
  doctorId: string;
  account: LoggedInAccount;
  workplaceId: string;
}
interface Clinic {
  manager: LoggedInAccount;
  branchId: string;
  a: Doctor;
  b: Doctor;
  day: JalaliDate;
}

async function doctorAt(
  branchId: string,
  manager: LoggedInAccount,
  day: JalaliDate,
): Promise<Doctor> {
  const doc = await staff(specialist, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: 'دکتر پیش‌فاکتور',
    medicalCouncilNumber: councilNumber(),
    treatmentFieldCodes: ['dental'],
    workplace: { kind: 'branch', branchId },
    ...reason,
  });
  expect(doc.status).toBe(201);
  const doctorId = doc.body['id'] as string;
  const account = await loggedInAccount(h, 'center');
  const linked = await staff(specialist, 'POST', `/catalog/doctors/${doctorId}/account`, {
    accountId: account.id,
    ...reason,
  });
  expect(linked.status).toBe(201);
  const detail = await staff(specialist, 'GET', `/catalog/doctors/${doctorId}`);
  const [place] = detail.body['workplaces'] as { id: string }[];
  const workplaceId = place?.id ?? '';
  expect((await price(manager, workplaceId, 'visit', '5000000', '8000000')).status).toBe(201);
  expect((await price(manager, workplaceId, 'scaling', '3000000', '3000000')).status).toBe(201);
  const extra = await staff(manager, 'POST', `/booking/workplaces/${workplaceId}/exceptions`, {
    kind: 'extra',
    on: day,
    start: '08:00',
    end: '20:00',
    slotMinutes: 30,
    serviceCodes: ['visit'],
    ...reason,
  });
  expect(extra.status).toBe(201);
  return { doctorId, account, workplaceId };
}

const price = (
  who: LoggedInAccount,
  workplaceId: string,
  serviceCode: string,
  minRial: string,
  maxRial: string,
) =>
  staff(who, 'POST', '/catalog/tariffs', {
    owner: { kind: 'workplace', workplaceId },
    serviceCode,
    pricing: { kind: 'range', minRial, maxRial },
    ...reason,
  });

/** An active center in Tehran with two doctors who have accounts. */
async function clinic(): Promise<Clinic> {
  const day = dayAhead(5);
  const created = await staff(specialist, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: 'کلینیک پیش‌فاکتور',
    cityCode: 'tehran',
    sheba: sheba(),
    accountHolderName: 'صاحب حساب',
    treatmentFieldCodes: ['dental'],
  });
  expect(created.status).toBe(201);
  const centerId = created.body['id'] as string;
  const setAll = async (status: string) => {
    const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
    for (const doc of detail.body['documents'] as { code: string }[]) {
      await staff(specialist, 'PUT', `/catalog/centers/${centerId}/documents/${doc.code}`, {
        status,
      });
    }
  };
  await setAll('received');
  await staff(specialist, 'POST', `/catalog/centers/${centerId}/submit`, reason);
  await setAll('verified');
  const proposed = await staff(
    specialist,
    'POST',
    `/catalog/centers/${centerId}/activation-requests`,
    reason,
  );
  const approved = await staff(
    approver,
    'POST',
    `/catalog/requests/${proposed.body['id'] as string}/approve`,
    {},
  );
  expect(approved.status).toBe(200);
  const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
  const [branch] = detail.body['branches'] as { id: string }[];
  const manager = await loggedInAccount(h, 'center');
  await grantRole(h, manager.id, 'center_manager', {
    kind: 'center',
    nodeId: created.body['nodeId'] as string,
  });
  const branchId = branch?.id ?? '';
  const a = await doctorAt(branchId, manager, day);
  const b = await doctorAt(branchId, manager, day);
  return { manager, branchId, a, b, day };
}

/** A patient books a visit with this doctor: the appointment and its referral. */
/** The next free half hour of this doctor on the clinic day, in order. */
const nextSlot = new Map<string, number>();

async function referred(d: Doctor, p?: Patient, examined = true) {
  const slot = nextSlot.get(d.workplaceId) ?? 0;
  nextSlot.set(d.workplaceId, slot + 1);
  const hour = 8 + Math.floor(slot / 2);
  const minute = (slot % 2) * 30;
  const who = p ?? (await patient());
  const held = await as(who, 'POST', '/booking/appointments/hold', {
    workplaceId: d.workplaceId,
    serviceCode: 'visit',
    startsAt: fromJalali(c.day, { hour, minute }).toISOString(),
  });
  expect(held.status).toBe(201);
  const appointmentId = held.body['id'] as string;
  expect((await as(who, 'POST', `/booking/appointments/${appointmentId}/request`)).status).toBe(
    201,
  );
  // A proforma is issued only after the examination (owner 1405/07/23).
  if (examined) await examineAppointment(h, c.manager, who.token, appointmentId);
  return { patient: who, appointmentId };
}

const lines = (over: Body = {}) => [
  { serviceCode: 'visit', quantity: 1, unitRial: '6000000', toothOrSite: '۱۶', ...over },
  { serviceCode: 'scaling', quantity: 2 },
];

async function draft(who: LoggedInAccount, appointmentId: string, body: unknown = lines()) {
  return staff(who, 'POST', '/proformas', { appointmentId, lines: body });
}
async function issued(who: LoggedInAccount, appointmentId: string, body: unknown = lines()) {
  const made = await draft(who, appointmentId, body);
  expect(made.status).toBe(201);
  const out = await staff(who, 'POST', `/proformas/${made.body['id'] as string}/issue`);
  expect(out.status, JSON.stringify(out.body)).toBe(201);
  return out.body;
}

async function customRole(permissions: PermissionCode[]) {
  const code = `sec_${Math.random().toString(36).slice(2, 10)}`;
  await h.app
    .get(AccessService)
    .createRole(CLI_ACTOR, { code, name: 'نقش منشی', permissions, reason: 'test fixture' });
  return code;
}

async function eventsOf(type: string, aggregateId: string) {
  const { rows } = await h.owner.query<Row>(
    'SELECT payload FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2',
    [type, aggregateId],
  );
  return rows;
}

let c: Clinic;

beforeAll(async () => {
  h = await startHarness();
  [specialist, otherCitySpecialist, networkManager, approver] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, otherCitySpecialist.id, 'network_specialist', {
    kind: 'city',
    code: 'isfahan',
  });
  await grantRole(h, networkManager.id, 'network_manager');
  await grantRole(h, approver.id, 'network_manager');
  expect(
    (
      await staff(networkManager, 'POST', '/catalog/fields', {
        code: 'dental',
        name: 'دندانپزشکی',
        ...reason,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await staff(networkManager, 'POST', '/catalog/services', {
        fieldCode: 'dental',
        code: 'scaling',
        name: 'جرم‌گیری',
        ...reason,
      })
    ).status,
  ).toBe(201);
  c = await clinic();
});

afterAll(async () => {
  await h.close();
});

describe('issuing (doc 10 §2)', () => {
  it('only once the appointment is examined (owner 1405/07/23): requested, confirmed, checked in are refused', async () => {
    const { patient: who, appointmentId } = await referred(c.a, undefined, false);
    const made = await draft(c.a.account, appointmentId);
    expect(made.status).toBe(201);
    const id = made.body['id'] as string;
    const tryIssue = async (expected: string) => {
      const out = await staff(c.a.account, 'POST', `/proformas/${id}/issue`);
      expect(out.status, expected).toBe(409);
      expect(out.body).toMatchObject({
        error: 'appointment_not_examined',
        appointmentStatus: expected,
      });
    };
    const statusOf = async () =>
      (await h.owner.query<Row>('SELECT status FROM proformas WHERE id = $1', [id])).rows[0]?.[
        'status'
      ];
    const visit = (path: string, body?: unknown) =>
      staff(c.manager, 'POST', `/booking/appointments/${appointmentId}/${path}`, body);

    const { rows } = await h.owner.query<Row>('SELECT status FROM appointments WHERE id = $1', [
      appointmentId,
    ]);
    if (rows[0]?.['status'] === 'requested') {
      await tryIssue('requested');
      expect((await visit('respond', { decision: 'confirm' })).status).toBe(201);
    }
    await tryIssue('confirmed');
    const mine = await as(who, 'GET', `/booking/me/appointments/${appointmentId}`);
    expect((await visit('check-in', { code: mine.body['checkInCode'] })).status).toBe(201);
    await tryIssue('checked_in');
    expect(await statusOf()).toBe('draft');
    expect(await eventsOf('proforma.issued', id)).toHaveLength(0);

    expect((await visit('examined')).status).toBe(201);
    const out = await staff(c.a.account, 'POST', `/proformas/${id}/issue`);
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(await statusOf()).toBe('issued');
    expect(await eventsOf('proforma.issued', id)).toHaveLength(1);
  });

  it('prices each line from the tariff in force, totals them, and issues with a deadline', async () => {
    const { appointmentId } = await referred(c.a);
    const made = await draft(c.a.account, appointmentId);
    expect(made.status).toBe(201);
    expect(made.body['status']).toBe('draft');
    expect(made.body['totalRial']).toBe(String(6_000_000 + 2 * 3_000_000));
    const [visit, scaling] = made.body['lines'] as Body[];
    expect(visit).toMatchObject({
      tariffMinRial: '5000000',
      tariffMaxRial: '8000000',
      deviates: false,
      toothOrSite: '16', // digits are stored in one form (rule 23)
    });
    expect(scaling).toMatchObject({
      unitRial: '3000000',
      lineTotalRial: '6000000',
      serviceName: 'جرم‌گیری',
    });

    const out = await staff(c.a.account, 'POST', `/proformas/${made.body['id'] as string}/issue`);
    expect(out.status).toBe(201);
    expect(out.body['status']).toBe('issued');
    const days =
      (Date.parse(out.body['validUntil'] as string) - Date.parse(out.body['issuedAt'] as string)) /
      86_400_000;
    expect(days).toBe(30);
    expect(await eventsOf('proforma.issued', made.body['id'] as string)).toHaveLength(1);
    // The database checks the total against the lines at commit.
    const { rows } = await h.owner.query<Row>(
      'SELECT total_rial::text AS t, (SELECT sum(line_total_rial)::text FROM proforma_lines WHERE proforma_id = $1) AS s FROM proformas WHERE id = $1',
      [made.body['id']],
    );
    expect(rows[0]?.['t']).toBe(rows[0]?.['s']);
  });

  it('only for a patient referred to this doctor through an appointment', async () => {
    const unknown = await draft(c.a.account, '0190a000-0000-7000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.body['error']).toBe('referral_not_found');
    // Doctor B for doctor A's patient: A's workplace is not in B's scope.
    const { appointmentId } = await referred(c.a);
    expect((await draft(c.b.account, appointmentId)).status).toBe(404);
    // The center manager sees the workplace but does not issue (doc 10: the doctor).
    const manager = await draft(c.manager, appointmentId);
    expect(manager.status).toBe(403);
  });

  it('the center manager issues no proforma: no draft, no issue, no revision (owner 1405/08/01)', async () => {
    const { appointmentId } = await referred(c.a);
    const countOf = async () =>
      Number(
        (
          await h.owner.query<Row>(
            'SELECT count(*)::text AS n FROM proformas p JOIN referrals r ON r.id = p.referral_id WHERE r.appointment_id = $1',
            [appointmentId],
          )
        ).rows[0]?.['n'],
      );
    expect((await draft(c.manager, appointmentId)).status).toBe(403);
    expect(await countOf()).toBe(0);
    // The doctor's own draft: the manager may neither issue it nor revise it.
    const made = await draft(c.a.account, appointmentId);
    expect(made.status).toBe(201);
    const id = made.body['id'] as string;
    const issue = await staff(c.manager, 'POST', `/proformas/${id}/issue`);
    expect(issue.status).toBe(403);
    expect((await staff(c.a.account, 'GET', `/proformas/${id}`)).body['status']).toBe('draft');
    expect((await staff(c.a.account, 'POST', `/proformas/${id}/issue`)).status).toBe(201);
    const revise = await staff(c.manager, 'POST', `/proformas/${id}/revise`, { lines: lines() });
    expect(revise.status).toBe(403);
    expect(await countOf()).toBe(1);
    // The manager still reads it (proforma.read, without treatment details).
    expect((await staff(c.manager, 'GET', `/proformas/${id}`)).status).toBe(200);
  });

  it('needs a reason for a price outside the tariff; then the network sees it in its queue', async () => {
    const { appointmentId } = await referred(c.a);
    const bare = await draft(c.a.account, appointmentId, lines({ unitRial: '9000000' }));
    expect(bare.status).toBe(400);
    expect(bare.body['error']).toBe('deviation_reason_required');
    const range = await draft(c.a.account, appointmentId, [{ serviceCode: 'visit', quantity: 1 }]);
    expect(range.status).toBe(400);
    expect(range.body['error']).toBe('unit_price_required');

    const out = await issued(
      c.a.account,
      appointmentId,
      lines({ unitRial: '9000000', deviationReason: 'درمان پیچیده‌تر از معمول' }),
    );
    const id = out['id'] as string;
    expect((out['lines'] as Body[])[0]?.['deviates']).toBe(true);

    const queue = await staff(specialist, 'GET', '/proformas/deviations');
    expect(queue.status).toBe(200);
    expect((queue.body['items'] as Body[]).map((p) => p['id'])).toContain(id);
    // Another city's specialist neither sees nor reviews it.
    const elsewhere = await staff(otherCitySpecialist, 'GET', '/proformas/deviations');
    expect((elsewhere.body['items'] as Body[]).map((p) => p['id'])).not.toContain(id);
    expect(
      (
        await staff(otherCitySpecialist, 'POST', `/proformas/${id}/deviation-review`, {
          note: 'بررسی شد',
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await staff(specialist, 'POST', `/proformas/${id}/deviation-review`, {
          note: 'با مرکز هماهنگ شد',
        })
      ).status,
    ).toBe(201);
    const after = await staff(specialist, 'GET', '/proformas/deviations');
    expect((after.body['items'] as Body[]).map((p) => p['id'])).not.toContain(id);
    const all = await staff(specialist, 'GET', '/proformas/deviations?reviewed=all');
    expect((all.body['items'] as Body[]).map((p) => p['id'])).toContain(id);
  });
});

describe('doc 10 §10 test 3: an issued line is never edited; a correction is a new version', () => {
  it('the database refuses a change to an issued proforma; revising makes version 2', async () => {
    const { appointmentId } = await referred(c.a);
    const v1 = await issued(c.a.account, appointmentId);
    const id = v1['id'] as string;
    await expect(
      h.owner.query('UPDATE proforma_lines SET unit_rial = 1 WHERE proforma_id = $1', [id]),
    ).rejects.toThrow();
    await expect(
      h.owner.query(
        `INSERT INTO proforma_lines (proforma_id, line_no, service_id, service_code, tariff_version_id,
           tariff_min_rial, tariff_max_rial, quantity, unit_rial, line_total_rial)
         SELECT proforma_id, 9, service_id, service_code, tariff_version_id, tariff_min_rial,
           tariff_max_rial, 1, unit_rial, unit_rial FROM proforma_lines WHERE proforma_id = $1 LIMIT 1`,
        [id],
      ),
    ).rejects.toThrow(/lines are fixed/);
    await expect(
      h.owner.query('UPDATE proformas SET total_rial = 1 WHERE id = $1', [id]),
    ).rejects.toThrow(/only change its state/);
    await expect(h.owner.query('DELETE FROM proformas WHERE id = $1', [id])).rejects.toThrow();

    const v2 = await staff(c.a.account, 'POST', `/proformas/${id}/revise`, {
      lines: [{ serviceCode: 'visit', quantity: 1, unitRial: '7000000' }],
    });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({
      version: 2,
      supersedesId: id,
      status: 'draft',
      totalRial: '7000000',
    });
    const second = await staff(c.a.account, 'POST', `/proformas/${id}/revise`, { lines: lines() });
    expect(second.status).toBe(409);
    expect(second.body['error']).toBe('revision_exists');

    const out = await staff(c.a.account, 'POST', `/proformas/${v2.body['id'] as string}/issue`);
    expect(out.status).toBe(201);
    const old = await staff(c.a.account, 'GET', `/proformas/${id}`);
    expect(old.body['status']).toBe('superseded');
    expect(old.body['totalRial']).toBe(v1['totalRial']);
    expect(await eventsOf('proforma.superseded', id)).toHaveLength(1);
  });

  it('a discarded draft leaves room for another revision, and stays on record', async () => {
    const { appointmentId } = await referred(c.a);
    const v1 = await issued(c.a.account, appointmentId);
    const id = v1['id'] as string;
    const draft2 = await staff(c.a.account, 'POST', `/proformas/${id}/revise`, { lines: lines() });
    const dropped = await staff(
      c.a.account,
      'POST',
      `/proformas/${draft2.body['id'] as string}/discard`,
      { reason: 'اشتباه در ردیف‌ها' },
    );
    expect(dropped.status).toBe(201);
    const { rows } = await h.owner.query<Row>(
      'SELECT discard_reason FROM proformas WHERE id = $1',
      [draft2.body['id']],
    );
    expect(rows[0]?.['discard_reason']).toBe('اشتباه در ردیف‌ها');
    expect(
      (await staff(c.a.account, 'POST', `/proformas/${id}/revise`, { lines: lines() })).status,
    ).toBe(201);
  });
});

describe('doc 10 §10 test 4: a tariff change after issue leaves the proforma alone', () => {
  it('keeps its prices; a draft made before the change cannot be issued', async () => {
    const d = await doctorAt(c.branchId, c.manager, c.day);
    const first = await referred(d);
    const done = await issued(d.account, first.appointmentId);
    const second = await referred(d);
    const pending = await draft(d.account, second.appointmentId);
    expect(pending.status).toBe(201);

    expect((await price(c.manager, d.workplaceId, 'visit', '9000000', '12000000')).status).toBe(
      201,
    );

    const after = await staff(d.account, 'GET', `/proformas/${done['id'] as string}`);
    expect(after.body['totalRial']).toBe(done['totalRial']);
    expect((after.body['lines'] as Body[])[0]).toMatchObject({
      tariffMinRial: '5000000',
      tariffMaxRial: '8000000',
      unitRial: '6000000',
    });
    const late = await staff(d.account, 'POST', `/proformas/${pending.body['id'] as string}/issue`);
    expect(late.status).toBe(409);
    expect(late.body['error']).toBe('tariff_changed');
  });
});

describe('who reaches a proforma (IDOR; doc 04 §4)', () => {
  it('doctor B never sees doctor A’s patient’s proforma; the manager sees it without treatment details', async () => {
    const { appointmentId } = await referred(c.a);
    const out = await issued(c.a.account, appointmentId);
    const id = out['id'] as string;
    expect((await staff(c.b.account, 'GET', `/proformas/${id}`)).status).toBe(404);
    expect(
      (await staff(c.b.account, 'GET', `/proformas/workplaces/${c.a.workplaceId}`)).status,
    ).toBe(404);
    const manager = await staff(c.manager, 'GET', `/proformas/${id}`);
    expect(manager.status).toBe(200);
    expect((manager.body['lines'] as Body[])[0]).not.toHaveProperty('toothOrSite');
    const doctor = await staff(c.a.account, 'GET', `/proformas/${id}`);
    expect((doctor.body['lines'] as Body[])[0]?.['toothOrSite']).toBe('16');
    const list = await staff(
      c.a.account,
      'GET',
      `/proformas/workplaces/${c.a.workplaceId}?status=issued`,
    );
    expect((list.body['items'] as Body[]).map((p) => p['id'])).toContain(id);
  });

  it('a secretary issues only by the doctor’s own delegation, recorded on the doctor’s behalf', async () => {
    const secretary = await loggedInAccount(h, 'center');
    const made = await staff(c.a.account, 'POST', '/catalog/secretaries', {
      workplaceId: c.a.workplaceId,
      accountId: secretary.id,
      name: 'منشی آزمون',
      ...reason,
    });
    expect(made.status).toBe(201);
    const { appointmentId } = await referred(c.a);
    expect((await draft(secretary, appointmentId)).status).toBe(403);
    const role = await customRole(['proforma.issue', 'proforma.read']);
    const granted = await staff(
      c.a.account,
      'POST',
      `/access/org-nodes/${made.body['nodeId'] as string}/assignments`,
      {
        roleCode: role,
        ...reason,
      },
    );
    expect(granted.status).toBe(201);
    const byHand = await draft(secretary, appointmentId);
    expect(byHand.status).toBe(201);
    const { rows } = await h.owner.query<Row>(
      `SELECT on_behalf_of_doctor_id FROM audit_events WHERE action = 'proforma.created' AND entity_id = $1`,
      [byHand.body['id']],
    );
    expect(rows[0]?.['on_behalf_of_doctor_id']).toBe(c.a.doctorId);
  });
});

describe('the patient (doc 10 §2)', () => {
  it('sees their issued proformas only, confirms one and disputes another', async () => {
    const p = await patient();
    const first = await referred(c.a, p);
    const second = await referred(c.a, p);
    const one = await issued(c.a.account, first.appointmentId);
    const pending = await draft(c.a.account, second.appointmentId);
    const mine = await as(p, 'GET', '/me/proformas');
    expect(mine.status).toBe(200);
    const ids = (mine.body as unknown as Body[]).map((x) => x['id']);
    expect(ids).toContain(one['id']);
    expect(ids).not.toContain(pending.body['id']);
    expect((await as(await patient(), 'GET', `/me/proformas/${one['id'] as string}`)).status).toBe(
      404,
    );

    const confirmed = await as(p, 'POST', `/me/proformas/${one['id'] as string}/confirm`);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body['status']).toBe('patient_confirmed');
    expect((await as(p, 'POST', `/me/proformas/${one['id'] as string}/confirm`)).status).toBe(409);
    expect(await eventsOf('proforma.confirmed', one['id'] as string)).toHaveLength(1);
    // A confirmed proforma is not revised here (task 3-4 decision).
    expect(
      (
        await staff(c.a.account, 'POST', `/proformas/${one['id'] as string}/revise`, {
          lines: lines(),
        })
      ).status,
    ).toBe(409);

    const two = await staff(
      c.a.account,
      'POST',
      `/proformas/${pending.body['id'] as string}/issue`,
    );
    const disputed = await as(p, 'POST', `/me/proformas/${two.body['id'] as string}/dispute`, {
      note: 'مبلغ جرم‌گیری با گفته پزشک فرق دارد',
    });
    expect(disputed.status).toBe(201);
    expect(disputed.body['status']).toBe('disputed');
    const { rows } = await h.owner.query<Row>(
      `SELECT subject_type, note, status FROM support_requests WHERE subject_id = $1`,
      [two.body['id']],
    );
    expect(rows).toEqual([
      { subject_type: 'proforma', note: 'مبلغ جرم‌گیری با گفته پزشک فرق دارد', status: 'open' },
    ]);
    // The doctor corrects a disputed one with a new version.
    expect(
      (
        await staff(c.a.account, 'POST', `/proformas/${two.body['id'] as string}/revise`, {
          lines: lines(),
        })
      ).status,
    ).toBe(201);
  });

  it('cannot answer once the deadline has passed; the scheduler expires the rest', async () => {
    const p = await patient();
    const { appointmentId } = await referred(c.a, p);
    const out = await issued(c.a.account, appointmentId);
    const later = new Date(Date.now() + 31 * 86_400_000);
    const service = h.app.get(ProformaService);
    await expect(
      service.confirm(
        { accountId: p.id, sessionId: null, ip: null, roles: [] },
        p.id,
        out['id'] as string,
        later,
      ),
    ).rejects.toMatchObject({ response: { error: 'proforma_expired' } });
    const now = await as(p, 'GET', `/me/proformas/${out['id'] as string}`);
    expect(now.body['status']).toBe('expired');

    const other = await referred(c.a);
    const open = await issued(c.a.account, other.appointmentId);
    expect(await service.expireOverdue(later)).toBeGreaterThanOrEqual(1);
    const swept = await staff(c.a.account, 'GET', `/proformas/${open['id'] as string}`);
    expect(swept.body['status']).toBe('expired');
    expect(await service.expireOverdue(later)).toBe(0);
    expect(await eventsOf('proforma.expired', open['id'] as string)).toHaveLength(1);
  });
});
