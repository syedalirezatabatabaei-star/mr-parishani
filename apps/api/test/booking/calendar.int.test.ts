import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gregorianDayOf,
  nextJalaliDay,
  toJalali,
  weekdayOf,
  type JalaliDate,
  type PermissionCode,
  type Weekday,
} from '@sepehr/contracts';
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
import { councilNumber, nationalId, sheba } from '../catalog/fixtures';

let h: Harness;
let specialist: LoggedInAccount;
let networkManager: LoggedInAccount;
let approver: LoggedInAccount;
let admin: LoggedInAccount;
let admin2: LoggedInAccount;

type Body = Record<string, unknown>;
const api = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

const reason = { reason: 'آزمون تقویم' };

interface Center {
  id: string;
  nodeId: string;
  branchId: string;
}

import { addHolidayByBatch } from '../config/holiday-batch';

/** A dental center taken through review to an approved activation. */
async function activeCenter(cityCode = 'tehran', by = specialist): Promise<Center> {
  const created = await api(by, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: 'کلینیک تقویم',
    cityCode,
    sheba: sheba(),
    accountHolderName: 'صاحب حساب',
    treatmentFieldCodes: ['dental'],
  });
  expect(created.status).toBe(201);
  const id = created.body['id'] as string;
  const setAll = async (status: string) => {
    const detail = await api(by, 'GET', `/catalog/centers/${id}`);
    for (const doc of detail.body['documents'] as { code: string }[]) {
      await api(by, 'PUT', `/catalog/centers/${id}/documents/${doc.code}`, { status });
    }
  };
  await setAll('received');
  await api(by, 'POST', `/catalog/centers/${id}/submit`, reason);
  await setAll('verified');
  const proposed = await api(by, 'POST', `/catalog/centers/${id}/activation-requests`, reason);
  const approved = await api(
    approver,
    'POST',
    `/catalog/requests/${proposed.body['id'] as string}/approve`,
    {},
  );
  expect(approved.status).toBe(200);
  const detail = await api(by, 'GET', `/catalog/centers/${id}`);
  const [branch] = detail.body['branches'] as { id: string }[];
  return { id, nodeId: created.body['nodeId'] as string, branchId: branch?.id ?? '' };
}

interface Dentist {
  id: string;
  account: LoggedInAccount | null;
  workplaceId: string;
}

async function dentist(workplace: Body, withAccount = false, by = specialist): Promise<Dentist> {
  const res = await api(by, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: 'دکتر دندان',
    medicalCouncilNumber: councilNumber(),
    treatmentFieldCodes: ['dental'],
    workplace,
    ...reason,
  });
  expect(res.status).toBe(201);
  const id = res.body['id'] as string;
  let account: LoggedInAccount | null = null;
  if (withAccount) {
    account = await loggedInAccount(h, 'center');
    const linked = await api(by, 'POST', `/catalog/doctors/${id}/account`, {
      accountId: account.id,
      ...reason,
    });
    expect(linked.status).toBe(201);
  }
  const detail = await api(by, 'GET', `/catalog/doctors/${id}`);
  const [place] = detail.body['workplaces'] as { id: string }[];
  return { id, account, workplaceId: place?.id ?? '' };
}

const atBranch = (center: Center) => ({ kind: 'branch', branchId: center.branchId });

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
  const code = `cal_${Math.random().toString(36).slice(2, 10)}`;
  await h.app
    .get(AccessService)
    .createRole(CLI_ACTOR, { code, name: 'نقش آزمون', permissions, reason: 'test fixture' });
  return code;
}

const range = (weekday: Weekday, start: string, end: string, slotMinutes = 30) => ({
  weekday,
  start,
  end,
  slotMinutes,
  serviceCodes: ['visit'],
});

const putSchedule = (who: LoggedInAccount, workplaceId: string, ranges: Body[]) =>
  api(who, 'PUT', `/booking/workplaces/${workplaceId}/schedule`, { ranges, ...reason });

const addException = (who: LoggedInAccount, workplaceId: string, body: Body) =>
  api(who, 'POST', `/booking/workplaces/${workplaceId}/exceptions`, { ...body, ...reason });

interface Day {
  jalali: JalaliDate;
  /** The Gregorian date of the Tehran day, as the API takes it. */
  day: string;
}

/**
 * A Tehran day of `weekday` at least `minDaysAhead` days from today, so every test has its
 * own week (holidays are one per day) and stays within the booking horizon (60 days).
 */
function upcoming(weekday: Weekday, minDaysAhead: number): Day {
  let date = toJalali(new Date());
  for (let i = 0; i < minDaysAhead; i++) date = nextJalaliDay(date);
  while (weekdayOf(date) !== weekday) date = nextJalaliDay(date);
  return { jalali: date, day: gregorianDayOf(date) };
}

const after = (d: Day): Day => {
  const next = nextJalaliDay(d.jalali);
  return { jalali: next, day: gregorianDayOf(next) };
};

async function slotsOf(who: LoggedInAccount, workplaceId: string, from: string, to = from) {
  const res = await api(
    who,
    'GET',
    `/booking/workplaces/${workplaceId}/slots?from=${from}&to=${to}`,
  );
  expect(res.status).toBe(200);
  return res.body as unknown as { startsAt: string; endsAt: string; serviceCodes: string[] }[];
}

/** Owner 1405/07/27: by a one-day batch, two holders of config.manage_holidays. */
async function addHoliday(on: JalaliDate, cityCode?: string) {
  const res = await addHolidayByBatch(h, admin, admin2, {
    on,
    ...(cityCode ? { cityCode } : {}),
  });
  expect(res.status).toBe(201);
}

async function auditOf(action: string, entityId: string) {
  const rows = await h.owner.query(
    `SELECT actor_account_id, on_behalf_of_doctor_id, before, after, reason FROM audit_events
     WHERE action = $1 AND entity_id = $2 ORDER BY seq`,
    [action, entityId],
  );
  return rows.rows as {
    actor_account_id: string | null;
    on_behalf_of_doctor_id: string | null;
    before: unknown;
    after: unknown;
    reason: string;
  }[];
}

beforeAll(async () => {
  h = await startHarness();
  [specialist, networkManager, approver, admin] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, networkManager.id, 'network_manager');
  await grantRole(h, approver.id, 'network_manager');
  await grantRole(h, admin.id, 'ceo');
  admin2 = await loggedInAccount(h, 'staff');
  await grantRole(h, admin2.id, 'ceo');
  expect(
    (
      await api(networkManager, 'POST', '/catalog/fields', {
        code: 'dental',
        name: 'دندانپزشکی',
        ...reason,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await api(networkManager, 'POST', '/catalog/services', {
        fieldCode: 'dental',
        code: 'implant',
        name: 'ایمپلنت',
        ...reason,
      })
    ).status,
  ).toBe(201);
  await api(networkManager, 'POST', '/catalog/fields', {
    code: 'eye',
    name: 'چشم‌پزشکی',
    ...reason,
  });
  await api(networkManager, 'POST', '/catalog/services', {
    fieldCode: 'eye',
    code: 'lasik',
    name: 'لیزیک',
    ...reason,
  });
});

afterAll(async () => {
  await h.close();
});

describe('who changes a calendar (task 2-5 decision 1)', () => {
  it('the doctor with an account, for their own workplace, audited as themselves', async () => {
    const center = await activeCenter();
    const doctor = await dentist(atBranch(center), true);
    const me = doctor.account as LoggedInAccount;

    const put = await putSchedule(me, doctor.workplaceId, [
      range('monday', '16:00', '20:00'),
      { ...range('saturday', '08:00', '12:00', 60), serviceCodes: ['visit', 'implant'] },
    ]);
    expect(put.status).toBe(200);
    const calendar = await api(me, 'GET', `/booking/workplaces/${doctor.workplaceId}/calendar`);
    expect(calendar.status).toBe(200);
    expect(calendar.body['schedule']).toEqual([
      {
        weekday: 'saturday',
        start: '08:00',
        end: '12:00',
        slotMinutes: 60,
        serviceCodes: ['visit', 'implant'],
      },
      { weekday: 'monday', start: '16:00', end: '20:00', slotMinutes: 30, serviceCodes: ['visit'] },
    ]);
    const [audit] = await auditOf('booking.schedule_replaced', doctor.workplaceId);
    expect(audit).toMatchObject({
      actor_account_id: me.id,
      on_behalf_of_doctor_id: null,
      before: [],
      reason: reason.reason,
    });
    expect(audit?.after).toHaveLength(2);

    // Only services the doctor can offer: the visit and their fields' services.
    const lasik = await putSchedule(me, doctor.workplaceId, [
      { ...range('monday', '08:00', '09:00'), serviceCodes: ['lasik'] },
    ]);
    expect(lasik.status).toBe(400);
    expect(lasik.body).toMatchObject({ error: 'service_not_offered', serviceCodes: ['lasik'] });
    // Two ranges of one day may not overlap.
    const overlap = await putSchedule(me, doctor.workplaceId, [
      range('monday', '08:00', '10:00'),
      range('monday', '09:30', '11:00'),
    ]);
    expect(overlap.status).toBe(400);
    expect(overlap.body['error']).toBe('schedule_overlap');
  });

  it('the center manager in scope, on the doctor’s behalf; another center’s does not see it', async () => {
    const center = await activeCenter();
    const doctor = await dentist(atBranch(center), true);
    const manager = await centerManagerOf(center);
    const put = await putSchedule(manager, doctor.workplaceId, [range('sunday', '09:00', '10:00')]);
    expect(put.status).toBe(200);
    const [audit] = await auditOf('booking.schedule_replaced', doctor.workplaceId);
    expect(audit).toMatchObject({
      actor_account_id: manager.id,
      on_behalf_of_doctor_id: doctor.id,
    });

    const stranger = await centerManagerOf(await activeCenter());
    expect((await putSchedule(stranger, doctor.workplaceId, [])).status).toBe(404);
    expect(
      (await api(stranger, 'GET', `/booking/workplaces/${doctor.workplaceId}/calendar`)).status,
    ).toBe(404);
  });

  it('Sepehr’s operator for any doctor of their city, a doctor without an account included', async () => {
    const doctor = await dentist({ kind: 'private_practice', cityCode: 'tehran' });
    const put = await putSchedule(specialist, doctor.workplaceId, [
      range('tuesday', '10:00', '11:00'),
    ]);
    expect(put.status).toBe(200);
    const [audit] = await auditOf('booking.schedule_replaced', doctor.workplaceId);
    expect(audit).toMatchObject({
      actor_account_id: specialist.id,
      on_behalf_of_doctor_id: doctor.id,
    });

    const elsewhere = await loggedInAccount(h, 'staff');
    await grantRole(h, elsewhere.id, 'network_specialist', { kind: 'city', code: 'tabriz' });
    expect((await putSchedule(elsewhere, doctor.workplaceId, [])).status).toBe(404);
  });

  it('is a matter of permissions, not roles', async () => {
    const center = await activeCenter();
    const doctor = await dentist(atBranch(center), true);
    // A center-scoped role with only «own calendar» manages nothing of this doctor's.
    const ownOnly = await customRole(['booking.read_calendar', 'booking.manage_own_calendar']);
    const who = await loggedInAccount(h, 'center');
    await grantRole(h, who.id, ownOnly, { kind: 'center', nodeId: center.nodeId });
    const refused = await putSchedule(who, doctor.workplaceId, [range('sunday', '09:00', '10:00')]);
    expect(refused.status).toBe(403);
    expect(refused.body['error']).toBe('calendar_managers_only');
    // The same scope with «in scope» does.
    const inScope = await customRole(['booking.read_calendar', 'booking.manage_calendar_in_scope']);
    const other = await loggedInAccount(h, 'center');
    await grantRole(h, other.id, inScope, { kind: 'center', nodeId: center.nodeId });
    expect(
      (await putSchedule(other, doctor.workplaceId, [range('sunday', '09:00', '10:00')])).status,
    ).toBe(200);
    // Reading alone changes nothing (the guard stops it).
    const reader = await loggedInAccount(h, 'staff');
    await grantRole(h, reader.id, 'auditor');
    expect((await putSchedule(reader, doctor.workplaceId, [])).status).toBe(403);
    expect(
      (await api(reader, 'GET', `/booking/workplaces/${doctor.workplaceId}/calendar`)).status,
    ).toBe(200);
  });

  it('«own calendar» alone reaches no doctor’s calendar, even seeing them all', async () => {
    // What the center manager and the network specialist hold only to delegate it
    // (task 2-5 decision): with the widest scope and nothing else, it changes nothing.
    const center = await activeCenter();
    const withAccount = await dentist(atBranch(center), true);
    const withoutAccount = await dentist(atBranch(center));
    const privatePractice = await dentist({ kind: 'private_practice', cityCode: 'tehran' });
    const ownOnly = await customRole(['booking.read_calendar', 'booking.manage_own_calendar']);
    const holder = await loggedInAccount(h, 'staff');
    await grantRole(h, holder.id, ownOnly);
    const day = upcoming('monday', 3);

    for (const doctor of [withAccount, withoutAccount, privatePractice]) {
      await putSchedule(specialist, doctor.workplaceId, [range('monday', '09:00', '10:00')]);
      const closed = await addException(specialist, doctor.workplaceId, {
        kind: 'closed',
        on: day.jalali,
      });
      expect(closed.status).toBe(201);
      const tries = [
        await putSchedule(holder, doctor.workplaceId, []),
        await addException(holder, doctor.workplaceId, { kind: 'open_holiday', on: day.jalali }),
        await api(
          holder,
          'POST',
          `/booking/exceptions/${closed.body['id'] as string}/remove`,
          reason,
        ),
      ];
      expect(tries.map((t) => [t.status, t.body['error']])).toEqual([
        [403, 'calendar_managers_only'],
        [403, 'calendar_managers_only'],
        [403, 'calendar_managers_only'],
      ]);
      // It sees the calendar (read_calendar, global scope), unchanged.
      const calendar = await api(
        holder,
        'GET',
        `/booking/workplaces/${doctor.workplaceId}/calendar`,
      );
      expect(calendar.status).toBe(200);
      expect(calendar.body['schedule']).toHaveLength(1);
      expect(calendar.body['exceptions']).toHaveLength(1);
    }

    // The real roles that hold it for delegation reach only what their other permissions do:
    // the center manager of another center, none of these.
    const otherManager = await centerManagerOf(await activeCenter());
    expect((await putSchedule(otherManager, withAccount.workplaceId, [])).status).toBe(404);
  });
});

describe('secretaries (doc 08 §15 test 6)', () => {
  it('manage their own doctor’s calendar when delegated, never another doctor’s, even with a tampered id', async () => {
    const center = await activeCenter();
    const a = await dentist(atBranch(center), true);
    const b = await dentist(atBranch(center), true);
    const doctorA = a.account as LoggedInAccount;
    const doctorB = b.account as LoggedInAccount;
    const { account: secretary, secretary: node } = await newSecretary(doctorA, a.workplaceId);

    // Nothing until the doctor delegates.
    expect((await putSchedule(secretary, a.workplaceId, [])).status).toBe(403);
    const role = await customRole([
      'booking.read_calendar',
      'booking.manage_own_calendar',
      'booking.manage_approval_mode',
    ]);
    const granted = await api(doctorA, 'POST', `/access/org-nodes/${node.nodeId}/assignments`, {
      roleCode: role,
      ...reason,
    });
    expect(granted.status).toBe(201);

    const own = await putSchedule(secretary, a.workplaceId, [range('saturday', '09:00', '10:00')]);
    expect(own.status).toBe(200);
    const [audit] = await auditOf('booking.schedule_replaced', a.workplaceId);
    expect(audit).toMatchObject({ actor_account_id: secretary.id, on_behalf_of_doctor_id: a.id });

    // Doctor B's calendar, by its real id: it does not exist for the secretary.
    const day = upcoming('sunday', 3);
    await putSchedule(doctorB, b.workplaceId, [range('sunday', '09:00', '10:00')]);
    const bException = await addException(doctorB, b.workplaceId, {
      kind: 'closed',
      on: day.jalali,
    });
    expect(bException.status).toBe(201);
    const tries = [
      await api(secretary, 'GET', `/booking/workplaces/${b.workplaceId}/calendar`),
      await api(
        secretary,
        'GET',
        `/booking/workplaces/${b.workplaceId}/slots?from=${day.day}&to=${day.day}`,
      ),
      await putSchedule(secretary, b.workplaceId, []),
      await addException(secretary, b.workplaceId, { kind: 'closed', on: day.jalali }),
      await api(
        secretary,
        'POST',
        `/booking/exceptions/${bException.body['id'] as string}/remove`,
        reason,
      ),
      await api(secretary, 'PUT', `/booking/workplaces/${b.workplaceId}/approval-mode`, {
        mode: 'auto',
        ...reason,
      }),
    ];
    expect(tries.map((t) => t.status)).toEqual([404, 404, 404, 404, 404, 404]);
    // Doctor B's calendar is unchanged.
    const bCalendar = await api(doctorB, 'GET', `/booking/workplaces/${b.workplaceId}/calendar`);
    expect(bCalendar.body['schedule']).toHaveLength(1);
    expect(bCalendar.body['exceptions']).toHaveLength(1);
    // Doctor A does not see doctor B's either.
    expect(
      (await api(doctorA, 'GET', `/booking/workplaces/${b.workplaceId}/calendar`)).status,
    ).toBe(404);

    // The approval mode is never a secretary's, even delegated (task 2-5 decision 2).
    const mode = await api(secretary, 'PUT', `/booking/workplaces/${a.workplaceId}/approval-mode`, {
      mode: 'auto',
      ...reason,
    });
    expect(mode.status).toBe(403);
    expect(mode.body['error']).toBe('secretary_not_allowed');
  });

  it('of a doctor without an account: the center manager delegates the calendar', async () => {
    const center = await activeCenter();
    const doctor = await dentist(atBranch(center));
    const manager = await centerManagerOf(center);
    const { account: secretary, secretary: node } = await newSecretary(manager, doctor.workplaceId);
    const role = await customRole(['booking.read_calendar', 'booking.manage_own_calendar']);
    const delegated = await api(manager, 'POST', `/catalog/secretaries/${node.id}/assignments`, {
      roleCode: role,
      ...reason,
    });
    expect(delegated.status).toBe(201);
    const put = await putSchedule(secretary, doctor.workplaceId, [
      range('monday', '09:00', '10:00'),
    ]);
    expect(put.status).toBe(200);
    const [audit] = await auditOf('booking.schedule_replaced', doctor.workplaceId);
    expect(audit).toMatchObject({
      actor_account_id: secretary.id,
      on_behalf_of_doctor_id: doctor.id,
    });
  });
});

describe('one doctor, two workplaces (task 2-5 decision 4)', () => {
  it('refuses a range that meets the doctor’s time elsewhere, naming nothing of it', async () => {
    const first = await activeCenter();
    const second = await activeCenter();
    const doctor = await dentist(atBranch(first), true);
    const added = await api(specialist, 'POST', `/catalog/doctors/${doctor.id}/workplaces`, {
      workplace: atBranch(second),
      ...reason,
    });
    expect(added.status).toBe(201);
    const detail = await api(specialist, 'GET', `/catalog/doctors/${doctor.id}`);
    const secondPlace = (detail.body['workplaces'] as { id: string }[]).find(
      (w) => w.id !== doctor.workplaceId,
    )?.id as string;
    const me = doctor.account as LoggedInAccount;

    expect(
      (await putSchedule(me, doctor.workplaceId, [range('wednesday', '08:00', '12:00')])).status,
    ).toBe(200);
    const clash = await putSchedule(me, secondPlace, [range('wednesday', '11:00', '13:00')]);
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: 'doctor_busy_elsewhere' });
    // Right after the first ends is free.
    expect(
      (await putSchedule(me, secondPlace, [range('wednesday', '12:00', '14:00')])).status,
    ).toBe(200);

    // Extra hours elsewhere on that weekday clash too, with the same answer.
    const day = upcoming('wednesday', 3);
    const extra = await addException(me, secondPlace, {
      kind: 'extra',
      on: day.jalali,
      start: '09:00',
      end: '10:00',
      slotMinutes: 30,
      serviceCodes: ['visit'],
    });
    expect(extra.status).toBe(409);
    expect(extra.body).toEqual({ error: 'doctor_busy_elsewhere' });
    // The second center's manager learns nothing of the first either.
    const manager = await centerManagerOf(second);
    const managed = await putSchedule(manager, secondPlace, [range('wednesday', '10:00', '11:00')]);
    expect(managed.status).toBe(409);
    expect(JSON.stringify(managed.body)).not.toContain(first.id);
    expect(JSON.stringify(managed.body)).not.toContain(doctor.workplaceId);
  });
});

describe('exceptions', () => {
  it('close a day or a range, add hours, are removed softly and only for today on', async () => {
    const doctor = await dentist({ kind: 'private_practice', cityCode: 'tehran' }, true);
    const me = doctor.account as LoggedInAccount;
    await putSchedule(me, doctor.workplaceId, [range('thursday', '08:00', '10:00')]);
    const day = upcoming('thursday', 10);
    expect(await slotsOf(me, doctor.workplaceId, day.day)).toHaveLength(4);

    const leave = await addException(me, doctor.workplaceId, {
      kind: 'closed',
      on: day.jalali,
      start: '08:30',
      end: '09:30',
    });
    expect(leave.status).toBe(201);
    expect((await slotsOf(me, doctor.workplaceId, day.day)).map((s) => s.startsAt)).toHaveLength(2);

    // Extra hours may not meet the open part of the weekly schedule…
    const clash = await addException(me, doctor.workplaceId, {
      kind: 'extra',
      on: day.jalali,
      start: '09:30',
      end: '10:30',
      slotMinutes: 60,
      serviceCodes: ['implant'],
    });
    expect(clash.status).toBe(400);
    expect(clash.body['error']).toBe('schedule_overlap');
    // …but may fill the closed part, or the evening.
    const evening = await addException(me, doctor.workplaceId, {
      kind: 'extra',
      on: day.jalali,
      start: '18:00',
      end: '19:00',
      slotMinutes: 60,
      serviceCodes: ['implant'],
    });
    expect(evening.status).toBe(201);
    const slots = await slotsOf(me, doctor.workplaceId, day.day);
    expect(slots).toHaveLength(3);
    expect(slots[2]?.serviceCodes).toEqual(['implant']);

    const removed = await api(
      me,
      'POST',
      `/booking/exceptions/${leave.body['id'] as string}/remove`,
      reason,
    );
    expect(removed.status).toBe(201);
    expect(await slotsOf(me, doctor.workplaceId, day.day)).toHaveLength(5);
    const [audit] = await auditOf('booking.exception_removed', leave.body['id'] as string);
    expect(audit).toMatchObject({ actor_account_id: me.id, reason: reason.reason });

    const past = await addException(me, doctor.workplaceId, {
      kind: 'closed',
      on: { year: 1400, month: 1, day: 5 },
    });
    expect(past.status).toBe(400);
    expect(past.body['error']).toBe('day_in_past');

    // Never physically deleted, never rewritten.
    await expect(
      h.owner.query('DELETE FROM availability_exceptions WHERE id = $1', [leave.body['id']]),
    ).rejects.toThrow();
    await expect(
      h.owner.query('DELETE FROM schedule_templates WHERE workplace_id = $1', [doctor.workplaceId]),
    ).rejects.toThrow();
  });
});

describe('holidays (doc 08 §15 test 3)', () => {
  it('a holiday gives no slot unless the doctor opened it; the weekly day off does not apply', async () => {
    const doctor = await dentist({ kind: 'private_practice', cityCode: 'tehran' }, true);
    const me = doctor.account as LoggedInAccount;
    await putSchedule(me, doctor.workplaceId, [
      range('saturday', '08:00', '09:00'),
      range('friday', '08:00', '09:00'),
    ]);
    const national = upcoming('saturday', 14);
    const city = upcoming('saturday', 21);
    const otherCity = upcoming('saturday', 28);
    const friday = upcoming('friday', 14);
    await addHoliday(national.jalali);
    await addHoliday(city.jalali, 'tehran');
    await addHoliday(otherCity.jalali, 'tabriz');

    expect(await slotsOf(me, doctor.workplaceId, national.day)).toEqual([]);
    expect(await slotsOf(me, doctor.workplaceId, city.day)).toEqual([]);
    expect(await slotsOf(me, doctor.workplaceId, otherCity.day)).toHaveLength(2);
    // Friday is the system's weekly day off, not the doctor's (task 2-5 decision 3).
    expect(await slotsOf(me, doctor.workplaceId, friday.day)).toHaveLength(2);

    const opened = await addException(me, doctor.workplaceId, {
      kind: 'open_holiday',
      on: national.jalali,
    });
    expect(opened.status).toBe(201);
    expect(await slotsOf(me, doctor.workplaceId, national.day)).toHaveLength(2);
    const twice = await addException(me, doctor.workplaceId, {
      kind: 'open_holiday',
      on: national.jalali,
    });
    expect(twice.status).toBe(409);
    expect(twice.body['error']).toBe('exception_exists');
  });
});

describe('Tehran midnight (doc 08 §15 test 13)', () => {
  it('slots belong to the Tehran day, not the UTC one', async () => {
    const doctor = await dentist({ kind: 'private_practice', cityCode: 'tehran' }, true);
    const me = doctor.account as LoggedInAccount;
    await putSchedule(me, doctor.workplaceId, [
      range('monday', '22:00', '24:00', 60),
      range('tuesday', '00:00', '02:00', 60),
    ]);
    const monday = upcoming('monday', 35);
    const tuesday = after(monday);

    // Tehran's Tuesday 00:00 is Monday 20:30 in UTC.
    const both = await slotsOf(me, doctor.workplaceId, monday.day, tuesday.day);
    expect(both.map((s) => s.startsAt)).toEqual([
      `${monday.day}T18:30:00.000Z`,
      `${monday.day}T19:30:00.000Z`,
      `${monday.day}T20:30:00.000Z`,
      `${monday.day}T21:30:00.000Z`,
    ]);
    expect(both[1]?.endsAt).toBe(`${monday.day}T20:30:00.000Z`);
    // Tuesday alone: its slots, though UTC calls them Monday.
    expect((await slotsOf(me, doctor.workplaceId, tuesday.day)).map((s) => s.startsAt)).toEqual([
      `${monday.day}T20:30:00.000Z`,
      `${monday.day}T21:30:00.000Z`,
    ]);
    // A holiday on Tehran's Tuesday closes exactly those two.
    await addHoliday(tuesday.jalali);
    expect(
      (await slotsOf(me, doctor.workplaceId, monday.day, tuesday.day)).map((s) => s.startsAt),
    ).toEqual([`${monday.day}T18:30:00.000Z`, `${monday.day}T19:30:00.000Z`]);
  });
});

describe('approval mode (task 2-5 decision 2)', () => {
  it('per workplace: the configured default until the doctor or a manager chooses; append-only', async () => {
    const center = await activeCenter();
    const doctor = await dentist(atBranch(center), true);
    const me = doctor.account as LoggedInAccount;
    const initial = await api(me, 'GET', `/booking/workplaces/${doctor.workplaceId}/calendar`);
    expect(initial.body['approvalMode']).toMatchObject({ mode: 'manual', source: 'default' });

    const byDoctor = await api(
      me,
      'PUT',
      `/booking/workplaces/${doctor.workplaceId}/approval-mode`,
      {
        mode: 'auto',
        ...reason,
      },
    );
    expect(byDoctor.status).toBe(200);
    expect(byDoctor.body).toMatchObject({ mode: 'auto', source: 'workplace' });
    const manager = await centerManagerOf(center);
    const byManager = await api(
      manager,
      'PUT',
      `/booking/workplaces/${doctor.workplaceId}/approval-mode`,
      {
        mode: 'manual',
        ...reason,
      },
    );
    expect(byManager.status).toBe(200);
    const audits = await auditOf('booking.approval_mode_set', doctor.workplaceId);
    expect(audits.map((a) => [a.actor_account_id, a.on_behalf_of_doctor_id])).toEqual([
      [me.id, null],
      [manager.id, doctor.id],
    ]);
    expect(audits[1]?.before).toMatchObject({ mode: 'auto', source: 'workplace' });
    const now = await api(me, 'GET', `/booking/workplaces/${doctor.workplaceId}/calendar`);
    expect(now.body['approvalMode']).toMatchObject({ mode: 'manual', source: 'workplace' });

    await expect(
      h.owner.query(`UPDATE workplace_approval_modes SET mode = 'auto' WHERE workplace_id = $1`, [
        doctor.workplaceId,
      ]),
    ).rejects.toThrow();
  });
});

describe('performance (task 2-5 acceptance)', () => {
  it('a month of one doctor’s slots in under 200 ms', async () => {
    const doctor = await dentist({ kind: 'private_practice', cityCode: 'tehran' }, true);
    const me = doctor.account as LoggedInAccount;
    const days: Weekday[] = ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday'];
    await putSchedule(
      me,
      doctor.workplaceId,
      days.flatMap((d) => [range(d, '08:00', '13:00', 15), range(d, '16:00', '21:00', 15)]),
    );
    const first = upcoming('saturday', 1);
    for (const offset of [7, 14]) {
      const d = upcoming('sunday', offset);
      await addException(me, doctor.workplaceId, {
        kind: 'closed',
        on: d.jalali,
        start: '08:00',
        end: '10:00',
      });
    }
    let last = first;
    for (let i = 0; i < 29; i++) last = after(last);

    const timings: number[] = [];
    let count = 0;
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const slots = await slotsOf(me, doctor.workplaceId, first.day, last.day);
      timings.push(performance.now() - started);
      count = slots.length;
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Infinity;
    expect(count).toBeGreaterThan(900);
    expect(p95).toBeLessThan(200);
  });
});
