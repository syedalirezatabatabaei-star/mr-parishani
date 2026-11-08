import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fromJalali,
  gregorianDayOf,
  nextJalaliDay,
  toJalali,
  type EventEnvelope,
  type JalaliDate,
  type SendTextJob,
} from '@sepehr/contracts';
import { AUDIT_LOG, type AuditLog } from '../../src/common/audit/audit.port';
import {
  ACCOUNT_DIRECTORY,
  type AccountDirectory,
} from '../../src/common/auth/account-directory.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../src/common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../src/common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../src/common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { AppointmentNotifier } from '../../src/modules/booking/appointment-notifier';
import { AppointmentSweeper } from '../../src/modules/booking/appointment-sweeper';
import { AppointmentService } from '../../src/modules/booking/appointment.service';
import { PersonService } from '../../src/modules/lead/person.service';
import { councilNumber, nationalId, sheba } from '../catalog/fixtures';
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

/**
 * Task 2-6 (doc 08 §7–8, ADR-027): appointments and referrals. Acceptance: doc 08 §15
 * tests 1, 2, 4 and 11, and 50 simultaneous requests for one slot give exactly one hold.
 */

let h: Harness;
let specialist: LoggedInAccount;
let networkManager: LoggedInAccount;
let approver: LoggedInAccount;

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const reason = { reason: 'آزمون نوبت' };

const staff = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

interface Patient {
  id: string;
  mobile: string;
  token: string;
}

async function patient(mobile = newMobile()): Promise<Patient> {
  const login = await otpLogin(h, mobile, 'mobile', { ip: newIp() });
  expect(login.status).toBe(200);
  const { rows } = await h.owner.query<Row>('SELECT id FROM user_accounts WHERE mobile = $1', [
    mobile,
  ]);
  return { id: rows[0]?.['id'] as string, mobile, token: login.body['accessToken'] as string };
}

const as = (
  p: Patient,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) =>
  call(h, method, path, {
    bearer: p.token,
    ...(body === undefined ? {} : { body }),
    ...(headers ? { headers } : {}),
  });

interface Clinic {
  centerId: string;
  manager: LoggedInAccount;
  doctorId: string;
  doctor: LoggedInAccount;
  workplaceId: string;
  day: JalaliDate;
}

/** A day far enough ahead for the cancellation cutoff, inside the 60-day horizon. */
function dayAhead(days: number): JalaliDate {
  let date = toJalali(new Date());
  for (let i = 0; i < days; i++) date = nextJalaliDay(date);
  return date;
}

const at = (day: JalaliDate, hour: number, minute = 0) =>
  fromJalali(day, { hour, minute }).toISOString();

/**
 * An active center, a doctor with an account at its branch, a visit price and extra hours
 * 09:00–12:00 in 30-minute slots on `day` (extra hours open even on a holiday).
 */
async function clinic(day = dayAhead(5)): Promise<Clinic> {
  const created = await staff(specialist, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: 'کلینیک نوبت',
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
  expect(
    (
      await staff(
        approver,
        'POST',
        `/catalog/requests/${proposed.body['id'] as string}/approve`,
        {},
      )
    ).status,
  ).toBe(200);
  const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
  const [branch] = detail.body['branches'] as { id: string }[];

  const manager = await loggedInAccount(h, 'center');
  await grantRole(h, manager.id, 'center_manager', {
    kind: 'center',
    nodeId: created.body['nodeId'] as string,
  });

  const doc = await staff(specialist, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: 'دکتر نوبت',
    medicalCouncilNumber: councilNumber(),
    treatmentFieldCodes: ['dental'],
    workplace: { kind: 'branch', branchId: branch?.id },
    ...reason,
  });
  expect(doc.status).toBe(201);
  const doctorId = doc.body['id'] as string;
  const doctor = await loggedInAccount(h, 'center');
  expect(
    (
      await staff(specialist, 'POST', `/catalog/doctors/${doctorId}/account`, {
        accountId: doctor.id,
        ...reason,
      })
    ).status,
  ).toBe(201);
  const doctorDetail = await staff(specialist, 'GET', `/catalog/doctors/${doctorId}`);
  const [place] = doctorDetail.body['workplaces'] as { id: string }[];
  const workplaceId = place?.id ?? '';

  expect((await setVisitPrice(manager, workplaceId, '5000000', '8000000')).status).toBe(201);
  const extra = await staff(manager, 'POST', `/booking/workplaces/${workplaceId}/exceptions`, {
    kind: 'extra',
    on: day,
    start: '09:00',
    end: '12:00',
    slotMinutes: 30,
    serviceCodes: ['visit'],
    ...reason,
  });
  expect(extra.status).toBe(201);
  return { centerId, manager, doctorId, doctor, workplaceId, day };
}

const setVisitPrice = (
  who: LoggedInAccount,
  workplaceId: string,
  minRial: string,
  maxRial: string,
) =>
  staff(who, 'POST', '/catalog/tariffs', {
    owner: { kind: 'workplace', workplaceId },
    serviceCode: 'visit',
    pricing: { kind: 'range', minRial, maxRial },
    ...reason,
  });

const holdBody = (c: Clinic, hour = 9, minute = 0): Body => ({
  workplaceId: c.workplaceId,
  serviceCode: 'visit',
  startsAt: at(c.day, hour, minute),
});

async function requested(p: Patient, c: Clinic, hour = 9, minute = 0) {
  const held = await as(p, 'POST', '/booking/appointments/hold', holdBody(c, hour, minute));
  // The answer's error code in the message: a 409 seen once under the full run (RESUME f6)
  // must say which refusal it was the next time.
  expect(held.status, JSON.stringify(held.body)).toBe(201);
  const id = held.body['id'] as string;
  const req = await as(p, 'POST', `/booking/appointments/${id}/request`);
  expect(req.status, JSON.stringify(req.body)).toBe(201);
  return req.body;
}

const setMode = (c: Clinic, mode: 'auto' | 'manual') =>
  staff(c.doctor, 'PUT', `/booking/workplaces/${c.workplaceId}/approval-mode`, { mode, ...reason });

/** Time passes for one hold: its expiry moves into the past (a test-only write). */
async function lapse(appointmentId: string) {
  await h.owner.query<Row>(
    `UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [appointmentId],
  );
}

async function referralsOf(appointmentId: string) {
  const { rows } = await h.owner.query<Row>('SELECT * FROM referrals WHERE appointment_id = $1', [
    appointmentId,
  ]);
  return rows;
}

async function eventsOf(type: string, aggregateId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT id, event_type, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
     WHERE event_type = $1 AND aggregate_id = $2 ORDER BY created_at`,
    [type, aggregateId],
  );
  return rows;
}

beforeAll(async () => {
  h = await startHarness();
  [specialist, networkManager, approver] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
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
});

afterAll(async () => {
  await h.close();
});

describe('doc 08 §15 test 1 and the 50-request acceptance: the database decides', () => {
  it('50 patients at once for one slot: exactly one hold, 49 slot_taken, no errors', async () => {
    const c = await clinic();
    const patients: Patient[] = [];
    for (let i = 0; i < 50; i++) patients.push(await patient());
    const results = await Promise.all(
      patients.map((p) => as(p, 'POST', '/booking/appointments/hold', holdBody(c, 10))),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(49);
    // Either the constraint refused it, or the slot was already seen taken.
    for (const r of refused)
      expect(['slot_taken', 'slot_not_available']).toContain(r.body['error']);
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM appointments WHERE workplace_id = $1 AND status = 'held'`,
      [c.workplaceId],
    );
    expect(rows[0]?.['n']).toBe(1);
  });

  it('two raw inserts of overlapping time: the exclusion constraint refuses the second', async () => {
    const c = await clinic();
    const insert = (
      client: { query: (q: string, v: unknown[]) => Promise<unknown> },
      startsAt: string,
      endsAt: string,
    ) =>
      client.query(
        `INSERT INTO appointments (workplace_id, doctor_id, mobile, service_code, starts_at, ends_at,
           status, channel, hold_expires_at, tariff_version_id, tariff_is_free,
           tariff_min_amount_rial, tariff_max_amount_rial)
         VALUES ($1, $2, '9120000000', 'visit', $3, $4, 'held', 'app', now() + interval '1 hour',
           gen_random_uuid(), false, 1, 1)`,
        [c.workplaceId, c.doctorId, startsAt, endsAt],
      );
    const a = await h.owner.connect();
    const b = await h.owner.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await insert(a, at(c.day, 9), at(c.day, 9, 30));
      // Overlapping by 15 minutes: b waits for a, then fails once a commits. Its failure is
      // taken at once, so it is never an unhandled rejection while a commits.
      const second = insert(b, at(c.day, 9, 15), at(c.day, 9, 45)).then(
        () => null,
        (error: unknown) => error,
      );
      await a.query('COMMIT');
      expect(await second).toMatchObject({ code: '23P01' });
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
    // Different doctor, same time: fine. Ended appointments never block.
    const other = await clinic();
    const c1 = await h.owner.connect();
    try {
      await insert(c1, at(c.day, 9), at(c.day, 9, 30)).catch(() => undefined);
      await expect(
        c1.query(
          `INSERT INTO appointments (workplace_id, doctor_id, mobile, service_code, starts_at, ends_at,
             status, channel, hold_expires_at, tariff_version_id, tariff_is_free,
             tariff_min_amount_rial, tariff_max_amount_rial)
           VALUES ($1, $2, '9120000000', 'visit', $3, $4, 'held', 'app', now() + interval '1 hour',
             gen_random_uuid(), false, 1, 1)`,
          [other.workplaceId, other.doctorId, at(c.day, 9), at(c.day, 9, 30)],
        ),
      ).resolves.toBeDefined();
    } finally {
      c1.release();
    }
  });

  it('a slot taken at one workplace is not offered at the doctor’s other one either', async () => {
    const c = await clinic();
    const p = await patient();
    expect((await as(p, 'POST', '/booking/appointments/hold', holdBody(c, 11))).status).toBe(201);
    const slots = await as(
      p,
      'GET',
      `/booking/workplaces/${c.workplaceId}/free-slots?from=${gregorianDayOf(c.day)}&to=${gregorianDayOf(c.day)}`,
    );
    expect(slots.status).toBe(200);
    const starts = (slots.body as unknown as { startsAt: string }[]).map((s) => s.startsAt);
    expect(starts).not.toContain(at(c.day, 11));
    expect(starts).toContain(at(c.day, 11, 30));
  });

  it('the same Idempotency-Key returns the first hold instead of a second one (rule 5)', async () => {
    const c = await clinic();
    const p = await patient();
    const key = { 'idempotency-key': `hold-${p.id}` };
    const first = await as(p, 'POST', '/booking/appointments/hold', holdBody(c, 9), key);
    const again = await as(p, 'POST', '/booking/appointments/hold', holdBody(c, 9), key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body['id']).toBe(first.body['id']);
  });
});

describe('doc 08 §15 test 2: a lapsed hold frees its slot', () => {
  it('free again at once, and the next patient takes it; the sweeper records the expiry', async () => {
    const c = await clinic();
    const first = await patient();
    const hold = await as(first, 'POST', '/booking/appointments/hold', holdBody(c, 9, 30));
    const held = hold.body as { id: string; status: string; holdExpiresAt: string };
    expect(held.status).toBe('held');
    // Ten minutes (booking.hold_minutes).
    const minutes = (Date.parse(held.holdExpiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    await lapse(held.id);

    // Offered again before any scheduler ran.
    const second = await patient();
    const slots = await as(
      second,
      'GET',
      `/booking/workplaces/${c.workplaceId}/free-slots?from=${gregorianDayOf(c.day)}&to=${gregorianDayOf(c.day)}`,
    );
    expect((slots.body as unknown as { startsAt: string }[]).map((s) => s.startsAt)).toContain(
      at(c.day, 9, 30),
    );
    const taken = await as(second, 'POST', '/booking/appointments/hold', holdBody(c, 9, 30));
    expect(taken.status).toBe(201);
    // The lapsed hold was moved to expired, with its history.
    const { rows } = await h.owner.query<Row>('SELECT status FROM appointments WHERE id = $1', [
      held.id,
    ]);
    expect(rows[0]?.['status']).toBe('expired');
    // The first patient can no longer request it.
    expect((await as(first, 'POST', `/booking/appointments/${held.id}/request`)).status).toBe(409);
  });

  it('the scheduler expires lapsed holds and unanswered requests whose time has come', async () => {
    const c = await clinic();
    const p = await patient();
    const held = (await as(p, 'POST', '/booking/appointments/hold', holdBody(c, 11, 30))).body as {
      id: string;
    };
    await lapse(held.id);
    const sweeper = new AppointmentSweeper(
      h.app.get<Database>(DATABASE),
      h.app.get<AuditLog>(AUDIT_LOG),
      h.app.get<OutboxPort>(OUTBOX),
      h.app.get<ConfigPort>(CONFIG),
    );
    const result = await sweeper.run();
    expect(result.holdsExpired).toBeGreaterThanOrEqual(1);
    const { rows } = await h.owner.query<Row>(
      `SELECT from_status, to_status, reason FROM appointment_status_changes
       WHERE appointment_id = $1 ORDER BY created_at`,
      [held.id],
    );
    expect(rows.at(-1)).toMatchObject({
      from_status: 'held',
      to_status: 'expired',
      reason: 'hold_lapsed',
    });
    expect(await eventsOf('booking.appointment_expired', held.id)).toHaveLength(1);

    // A request the center never answered expires once its start has come.
    const other = await requested(await patient(), c, 10);
    const later = new Date(new Date(at(c.day, 10)).getTime() + 60_000);
    await sweeper.run(later);
    const { rows: after } = await h.owner.query<Row>(
      'SELECT status FROM appointments WHERE id = $1',
      [other['id']],
    );
    expect(after[0]?.['status']).toBe('expired');
  });
});

describe('doc 08 §15 test 4: a tariff change does not reach a booked appointment', () => {
  it('keeps the version and range quoted at booking', async () => {
    const c = await clinic();
    const p = await patient();
    const booked = await requested(p, c, 9);
    const price = booked['price'] as Body;
    expect(price).toMatchObject({
      minAmountRial: '5000000',
      maxAmountRial: '8000000',
      isFree: false,
    });

    expect((await setVisitPrice(c.manager, c.workplaceId, '9000000', '12000000')).status).toBe(201);
    const later = await as(p, 'GET', `/booking/me/appointments/${booked['id'] as string}`);
    expect(later.body['price']).toEqual(price);
    // A new booking gets the new price.
    const fresh = await requested(await patient(), c, 10);
    expect(fresh['price']).toMatchObject({ minAmountRial: '9000000', maxAmountRial: '12000000' });
    // Not even the schema owner moves the slot or the price of a booking (grants and trigger).
    const { rows } = await h.owner.query<Row>(
      `SELECT has_column_privilege('sepehr_app', 'appointments', 'tariff_min_amount_rial', 'UPDATE') AS p`,
    );
    expect(rows[0]?.['p']).toBe(false);
  });
});

describe('doc 08 §15 test 11: exactly one referral per appointment, never changed', () => {
  it('a request writes one referral on the person and case; it cannot be edited or deleted', async () => {
    const c = await clinic();
    const p = await patient();
    const booked = await requested(p, c, 9);
    const id = booked['id'] as string;
    const [referral, ...more] = await referralsOf(id);
    expect(more).toEqual([]);
    const { rows: accounts } = await h.owner.query<Row>(
      'SELECT person_id FROM user_accounts WHERE id = $1',
      [p.id],
    );
    expect(referral).toMatchObject({
      person_id: accounts[0]?.['person_id'],
      doctor_id: c.doctorId,
      workplace_id: c.workplaceId,
      channel: 'app',
      supersedes_referral_id: null,
    });
    expect(referral?.['case_id']).toBeTruthy();
    expect(await eventsOf('booking.referral_created', referral?.['id'] as string)).toHaveLength(1);

    // Neither the app role nor the owner changes or removes it.
    await expect(
      h.owner.query<Row>('UPDATE referrals SET channel = $1 WHERE id = $2', [
        'web',
        referral?.['id'],
      ]),
    ).rejects.toThrow();
    await expect(
      h.owner.query<Row>('DELETE FROM referrals WHERE id = $1', [referral?.['id']]),
    ).rejects.toThrow();
    const { rows: grants } = await h.owner.query<Row>(
      `SELECT has_table_privilege('sepehr_app', 'referrals', 'UPDATE') AS u,
              has_table_privilege('sepehr_app', 'referrals', 'DELETE') AS d`,
    );
    expect(grants[0]).toEqual({ u: false, d: false });

    // Confirming, checking in, finishing: still one referral.
    await staff(c.manager, 'POST', `/booking/appointments/${id}/respond`, { decision: 'confirm' });
    expect(await referralsOf(id)).toHaveLength(1);
    // A hold that never became a request has none.
    const onlyHeld = await as(
      await patient(),
      'POST',
      '/booking/appointments/hold',
      holdBody(c, 11),
    );
    expect(await referralsOf(onlyHeld.body['id'] as string)).toEqual([]);
  });
});

describe('the lifecycle (doc 08 §7)', () => {
  it('the secretary handles their own doctor’s appointments only, and issues no proforma (owner 1405/08/01; 0105)', async () => {
    const c = await clinic();
    const other = await clinic();
    const { rows } = await h.owner.query<Row>(
      'SELECT node_id FROM doctor_workplaces WHERE id = $1',
      [c.workplaceId],
    );
    const doctorNode = rows[0]?.['node_id'] as string;
    const secretary = await loggedInAccount(h, 'center');
    await createNode(h, 'secretary', { parentId: doctorNode, accountId: secretary.id });
    await grantRole(h, secretary.id, 'secretary', { kind: 'doctor', nodeId: doctorNode });

    const p = await patient();
    const mine = (await requested(p, c, 9))['id'] as string;
    const confirmed = await staff(secretary, 'POST', `/booking/appointments/${mine}/respond`, {
      decision: 'confirm',
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body['status']).toBe('confirmed');
    expect(confirmed.body['checkInCode']).toBeUndefined();

    // Another doctor's appointment does not exist for them (rule 13).
    const theirs = (await requested(await patient(), other, 9))['id'] as string;
    const refused = await staff(secretary, 'POST', `/booking/appointments/${theirs}/respond`, {
      decision: 'confirm',
    });
    expect(refused.status).toBe(404);
    const { rows: still } = await h.owner.query<Row>(
      'SELECT status FROM appointments WHERE id = $1',
      [theirs],
    );
    expect(still[0]?.['status']).toBe('requested');

    // The doctor issues proformas; the secretary does not (no proforma.issue in the role).
    const draft = await staff(secretary, 'POST', '/proformas', {
      appointmentId: mine,
      lines: [{ serviceCode: 'visit', quantity: 1, unitRial: '6000000' }],
    });
    expect(draft.status).toBe(403);
  });

  it('manual: requested with a deadline → confirmed with a code → checked in → paid → examined', async () => {
    const c = await clinic();
    const p = await patient();
    const booked = await requested(p, c, 9);
    const id = booked['id'] as string;
    expect(booked).toMatchObject({ status: 'requested', approvalMode: 'manual' });
    expect(booked['approvalDueAt']).toBeTruthy();

    const pending = await staff(
      c.manager,
      'GET',
      `/booking/workplaces/${c.workplaceId}/pending-approvals`,
    );
    expect(pending.body).toEqual({ approvalMode: 'manual', waitingForManualApproval: 1 });

    const confirmed = await staff(c.manager, 'POST', `/booking/appointments/${id}/respond`, {
      decision: 'confirm',
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body['status']).toBe('confirmed');
    // The center never sees the code; the patient does.
    expect(confirmed.body['checkInCode']).toBeUndefined();
    const mine = await as(p, 'GET', `/booking/me/appointments/${id}`);
    const code = mine.body['checkInCode'] as string;
    expect(code).toMatch(/^[0-9]{6}$/);

    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await staff(c.manager, 'POST', `/booking/appointments/${id}/check-in`, {
      code: wrong,
    });
    expect(bad.status).toBe(400);
    const { rows } = await h.owner.query<Row>(
      'SELECT check_in_attempts FROM appointments WHERE id = $1',
      [id],
    );
    expect(rows[0]?.['check_in_attempts']).toBe(1);

    // Visit paid only after check-in.
    expect(
      (
        await staff(c.manager, 'POST', `/booking/appointments/${id}/visit-payment`, {
          amountRial: '6000000',
        })
      ).status,
    ).toBe(409);
    const ok = await staff(c.manager, 'POST', `/booking/appointments/${id}/check-in`, { code });
    expect(ok.status).toBe(201);
    expect(ok.body['status']).toBe('checked_in');
    expect(
      (
        await staff(c.manager, 'POST', `/booking/appointments/${id}/visit-payment`, {
          amountRial: '99',
        })
      ).body['error'],
    ).toBe('amount_out_of_range');
    expect(
      (
        await staff(c.manager, 'POST', `/booking/appointments/${id}/visit-payment`, {
          amountRial: '6000000',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await staff(c.manager, 'POST', `/booking/appointments/${id}/visit-payment`, {
          amountRial: '6000000',
        })
      ).body['error'],
    ).toBe('visit_already_paid');
    const done = await staff(c.manager, 'POST', `/booking/appointments/${id}/examined`);
    expect(done.body['status']).toBe('examined');

    // Every move is in the history and the audit trail, on the doctor's behalf.
    const { rows: history } = await h.owner.query<Row>(
      'SELECT to_status FROM appointment_status_changes WHERE appointment_id = $1 ORDER BY created_at',
      [id],
    );
    expect(history.map((r) => r['to_status'])).toEqual([
      'held',
      'requested',
      'confirmed',
      'checked_in',
      'examined',
    ]);
    const { rows: audits } = await h.owner.query<Row>(
      `SELECT on_behalf_of_doctor_id FROM audit_events
       WHERE entity_id = $1 AND action = 'booking.appointment_moved' AND actor_account_id = $2`,
      [id, c.manager.id],
    );
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(a['on_behalf_of_doctor_id']).toBe(c.doctorId);
  });

  it('the database refuses a move outside the lifecycle, whoever writes it (rule 8)', async () => {
    const c = await clinic();
    const booked = await requested(await patient(), c, 9);
    await expect(
      h.owner.query<Row>(`UPDATE appointments SET status = 'examined' WHERE id = $1`, [
        booked['id'],
      ]),
    ).rejects.toThrow(/cannot move from requested to examined/);
    const { rows } = await h.owner.query<Row>(
      `SELECT has_column_privilege('sepehr_app', 'appointments', 'starts_at', 'UPDATE') AS p`,
    );
    expect(rows[0]?.['p']).toBe(false);
  });

  it('automatic: confirmed at once, with a confirmed-SMS rendered from the panel texts', async () => {
    const c = await clinic();
    expect((await setMode(c, 'auto')).status).toBe(200);
    const p = await patient();
    const booked = await requested(p, c, 9);
    expect(booked).toMatchObject({
      status: 'confirmed',
      approvalMode: 'auto',
      approvalDueAt: null,
    });
    const code = booked['checkInCode'] as string;
    expect(code).toMatch(/^[0-9]{6}$/);

    const [event] = await eventsOf('booking.appointment_confirmed', booked['id'] as string);
    const sent: { job: SendTextJob; id: string }[] = [];
    const notifier = new AppointmentNotifier(
      { register: () => undefined },
      h.app.get<ConfigPort>(CONFIG),
      h.app.get<WorkplaceDirectory>(WORKPLACE_DIRECTORY),
      h.app.get<AccountDirectory>(ACCOUNT_DIRECTORY),
      h.app.get<LeadCases>(LEAD_CASES),
      { sendText: (job, id) => Promise.resolve(void sent.push({ job, id })) },
    );
    const envelope: EventEnvelope = {
      id: event?.['id'] as string,
      type: 'booking.appointment_confirmed',
      aggregateType: 'appointment',
      aggregateId: booked['id'] as string,
      payload: event?.['payload'],
      occurredAt: (event?.['created_at'] as Date).toISOString(),
    };
    await notifier.handle(envelope, h.app.get<Database>(DATABASE));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.job.mobile).toBe(p.mobile);
    expect(sent[0]?.job.text).toContain('دکتر نوبت');
    expect(sent[0]?.job.text).toContain('کلینیک نوبت');
    expect(sent[0]?.id).toBe(`booking-${envelope.id}`);
  });

  it('decision 1: switching to automatic confirms nothing already waiting; the panel warns', async () => {
    const c = await clinic();
    const waiting = await requested(await patient(), c, 9);
    expect(waiting['status']).toBe('requested');
    expect((await setMode(c, 'auto')).status).toBe(200);

    const still = await staff(c.manager, 'GET', `/booking/appointments/${waiting['id'] as string}`);
    expect(still.body).toMatchObject({ status: 'requested', approvalMode: 'manual' });
    const pending = await staff(
      c.manager,
      'GET',
      `/booking/workplaces/${c.workplaceId}/pending-approvals`,
    );
    expect(pending.body).toEqual({ approvalMode: 'auto', waitingForManualApproval: 1 });
    const fresh = await requested(await patient(), c, 10);
    expect(fresh).toMatchObject({ status: 'confirmed', approvalMode: 'auto' });
  });

  it('cancellation: the patient until the cutoff, the center with a reason', async () => {
    const c = await clinic();
    await setMode(c, 'auto');
    const p = await patient();
    const booked = await requested(p, c, 9);
    const id = booked['id'] as string;
    const service = h.app.get(AppointmentService);
    // An hour before: past the two-hour cutoff.
    const tooLate = new Date(new Date(at(c.day, 9)).getTime() - 60 * 60_000);
    await expect(
      service.cancelByPatient(actorFor(p.id), p.id, id, 'دیر است', tooLate),
    ).rejects.toMatchObject({
      response: { error: 'too_late_to_change' },
    });
    const cancelled = await as(p, 'POST', `/booking/me/appointments/${id}/cancel`, reason);
    expect(cancelled.body['status']).toBe('cancelled_by_patient');
    const [event] = await eventsOf('booking.appointment_cancelled', id);
    expect(event?.['payload']).toMatchObject({ by: 'patient' });

    const other = await requested(await patient(), c, 10);
    const byCenter = await staff(
      c.manager,
      'POST',
      `/booking/appointments/${other['id'] as string}/cancel`,
      reason,
    );
    expect(byCenter.body['status']).toBe('cancelled_by_center');
    // A request may be withdrawn too (decision 5).
    await setMode(c, 'manual');
    const q = await patient();
    const req = await requested(q, c, 11);
    expect(
      (await as(q, 'POST', `/booking/me/appointments/${req['id'] as string}/cancel`, reason)).body[
        'status'
      ],
    ).toBe('cancelled_by_patient');
  });

  it('no-show only after the start; the patient disputes, the network decides once', async () => {
    const c = await clinic();
    await setMode(c, 'auto');
    const p = await patient();
    const id = (await requested(p, c, 9))['id'] as string;
    expect(
      (await staff(c.manager, 'POST', `/booking/appointments/${id}/no-show`, reason)).body['error'],
    ).toBe('appointment_not_started');
    const service = h.app.get(AppointmentService);
    const access = {
      accountId: c.manager.id,
      roles: [],
      permissions: new Set(['booking.manage_appointments'] as const),
      scopes: [{ kind: 'global' as const }],
    };
    const after = new Date(new Date(at(c.day, 9)).getTime() + 30 * 60_000);
    const marked = await service.markNoShow(actorFor(c.manager.id), access, id, 'نیامد', after);
    expect(marked.status).toBe('no_show');

    expect(
      (await as(p, 'POST', `/booking/me/appointments/${id}/dispute-no-show`, reason)).status,
    ).toBe(201);
    expect(
      (await as(p, 'POST', `/booking/me/appointments/${id}/dispute-no-show`, reason)).body['error'],
    ).toBe('already_disputed');
    const decided = await staff(
      specialist,
      'POST',
      `/booking/appointments/${id}/no-show-dispute/resolve`,
      {
        outcome: 'overturned',
        ...reason,
      },
    );
    expect(decided.status).toBe(201);
    expect(
      (
        await staff(specialist, 'POST', `/booking/appointments/${id}/no-show-dispute/resolve`, {
          outcome: 'upheld',
          ...reason,
        })
      ).body['error'],
    ).toBe('dispute_already_decided');
    expect(await eventsOf('booking.no_show_dispute_resolved', id)).toHaveLength(1);
  });
});

describe('decision 4: moving an appointment', () => {
  it('the old one becomes rescheduled; the new referral supersedes it and keeps the first date', async () => {
    const c = await clinic();
    await setMode(c, 'auto');
    const p = await patient();
    const first = await requested(p, c, 9);
    const firstId = first['id'] as string;
    const [firstReferral] = await referralsOf(firstId);

    const moved = await as(p, 'POST', `/booking/me/appointments/${firstId}/reschedule`, {
      startsAt: at(c.day, 9, 30),
      ...reason,
    });
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ status: 'confirmed', rescheduledFromId: firstId });
    expect(moved.body['price']).toEqual(first['price']);
    const { rows } = await h.owner.query<Row>('SELECT status FROM appointments WHERE id = $1', [
      firstId,
    ]);
    expect(rows[0]?.['status']).toBe('rescheduled');

    const [newReferral, ...more] = await referralsOf(moved.body['id'] as string);
    expect(more).toEqual([]);
    expect(newReferral?.['supersedes_referral_id']).toBe(firstReferral?.['id']);
    expect((newReferral?.['referred_at'] as Date).toISOString()).toBe(
      (firstReferral?.['referred_at'] as Date).toISOString(),
    );
    // Moved again by the center: still one chain, still the first date.
    const again = await staff(
      c.manager,
      'POST',
      `/booking/appointments/${moved.body['id'] as string}/reschedule`,
      {
        startsAt: at(c.day, 10),
        ...reason,
      },
    );
    expect(again.status).toBe(201);
    const [third] = await referralsOf(again.body['id'] as string);
    expect(third?.['supersedes_referral_id']).toBe(newReferral?.['id']);
    expect((third?.['referred_at'] as Date).toISOString()).toBe(
      (firstReferral?.['referred_at'] as Date).toISOString(),
    );
    // The freed time is free again.
    const slots = await as(
      p,
      'GET',
      `/booking/workplaces/${c.workplaceId}/free-slots?from=${gregorianDayOf(c.day)}&to=${gregorianDayOf(c.day)}`,
    );
    const starts = (slots.body as unknown as { startsAt: string }[]).map((s) => s.startsAt);
    expect(starts).toContain(at(c.day, 9));
    expect(starts).toContain(at(c.day, 9, 30));
    expect(starts).not.toContain(at(c.day, 10));
  });
});

describe('decisions 2 and 3: the person and the case (lead module)', () => {
  it('an open case is reused: no second case, no new assignment', async () => {
    const c = await clinic();
    await setMode(c, 'auto');
    const p = await patient();
    const first = await requested(p, c, 9);
    const second = await requested(p, c, 10);
    const [a] = await referralsOf(first['id'] as string);
    const [b] = await referralsOf(second['id'] as string);
    expect(b?.['case_id']).toBe(a?.['case_id']);
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM case_assignments WHERE case_id = $1',
      [a?.['case_id']],
    );
    const { rows: intakes } = await h.owner.query<Row>(
      `SELECT category FROM case_intakes WHERE case_id = $1 ORDER BY created_at`,
      [a?.['case_id']],
    );
    expect(intakes.map((r) => r['category'])).toEqual(['new', 'duplicate_active']);
    // The second intake assigned nobody: as many assignment rows as after the first.
    expect(rows[0]?.['n']).toBeLessThanOrEqual(1);
  });

  it('abuse: refused with a reason-free error; do_not_contact: booked, no case, SMS still sent', async () => {
    const c = await clinic();
    await setMode(c, 'auto');
    const persons = h.app.get(PersonService);
    const everything = {
      accountId: '',
      roles: [],
      permissions: new Set(['lead.block_person'] as const),
      scopes: [{ kind: 'global' as const }],
    };

    const abusive = await patient();
    const { rows: ab } = await h.owner.query<Row>(
      'SELECT person_id FROM user_accounts WHERE id = $1',
      [abusive.id],
    );
    await persons.block(CLI_ACTOR, everything, ab[0]?.['person_id'] as string, {
      kind: 'abuse',
      reason: 'سوءاستفاده',
    });
    const refused = await as(abusive, 'POST', '/booking/appointments/hold', holdBody(c, 9));
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'booking_unavailable' });

    const quiet = await patient();
    const { rows: qp } = await h.owner.query<Row>(
      'SELECT person_id FROM user_accounts WHERE id = $1',
      [quiet.id],
    );
    await persons.block(CLI_ACTOR, everything, qp[0]?.['person_id'] as string, {
      kind: 'do_not_contact',
      reason: 'تماس نگیرید',
    });
    const booked = await requested(quiet, c, 10);
    expect(booked['status']).toBe('confirmed');
    const [referral] = await referralsOf(booked['id'] as string);
    expect(referral).toMatchObject({ person_id: qp[0]?.['person_id'], case_id: null });
    expect(await eventsOf('booking.appointment_confirmed', booked['id'] as string)).toHaveLength(1);
  });

  it('an advisor books for a mobile; the referral says so', async () => {
    const c = await clinic();
    const advisor = await loggedInAccount(h, 'staff');
    await grantRole(h, advisor.id, 'advisor');
    const mobile = newMobile();
    const held = await staff(advisor, 'POST', '/booking/advisor/appointments/hold', {
      ...holdBody(c, 11),
      mobile,
    });
    expect(held.status).toBe(201);
    expect(held.body['channel']).toBe('advisor');
    const req = await staff(
      advisor,
      'POST',
      `/booking/advisor/appointments/${held.body['id'] as string}/request`,
    );
    expect(req.status).toBe(201);
    const [referral] = await referralsOf(held.body['id'] as string);
    expect(referral?.['channel']).toBe('advisor');
    // A patient cannot use the advisor's door, nor an advisor the patient's.
    const p = await patient();
    expect(
      (await as(p, 'POST', '/booking/advisor/appointments/hold', { ...holdBody(c, 9), mobile }))
        .status,
    ).toBe(403);
    expect(
      (await staff(advisor, 'POST', '/booking/appointments/hold', holdBody(c, 9))).body['error'],
    ).toBe('patients_only');
    // The patient of that mobile, once logged in, sees it as theirs.
    const owner = await patient(mobile);
    const mine = await as(owner, 'GET', '/booking/me/appointments');
    expect((mine.body['items'] as { id: string }[]).map((a) => a.id)).toContain(held.body['id']);
  });
});

describe("the patient's list: filtered and paged on the server (task 2-11)", () => {
  it('filters by upcoming or past, status and day; pages; names the doctor, place and service', async () => {
    const c = await clinic();
    const p = await patient();
    const ids: string[] = [];
    for (const hour of [9, 10, 11]) ids.push((await requested(p, c, hour))['id'] as string);
    // One of them ended in the past (a test-only write: time passes).
    await h.owner.query<Row>(
      `UPDATE appointments SET starts_at = now() - interval '1 day',
         ends_at = now() - interval '1 day' + interval '30 minutes' WHERE id = $1`,
      [ids[0]],
    );
    const list = async (query: string) => {
      const res = await as(p, 'GET', `/booking/me/appointments${query}`);
      expect(res.status).toBe(200);
      return res.body as { page: number; pageSize: number; total: number; items: Row[] };
    };

    const upcoming = await list('?when=upcoming');
    expect(upcoming.items.map((a) => a['id'])).toEqual([ids[1], ids[2]]);
    expect(upcoming.items[0]).toMatchObject({
      // Not `doctorName`: that key is the treatment class of doc 04 §4, stripped for patients.
      doctor: { id: c.doctorId, name: 'دکتر نوبت' },
      placeName: 'کلینیک نوبت',
      serviceCode: 'visit',
    });
    expect(upcoming.items[0]?.['serviceName']).not.toBe('visit');
    expect((await list('?when=past')).items.map((a) => a['id'])).toEqual([ids[0]]);

    const paged = await list('?pageSize=1&page=2');
    expect(paged).toMatchObject({ page: 2, pageSize: 1, total: 3 });
    expect(paged.items).toHaveLength(1);

    expect((await list('?status=confirmed')).total).toBe(0);
    expect((await list('?status=requested&when=upcoming')).total).toBe(2);
    // Tehran days: the appointments' own day holds the two upcoming ones.
    const day = gregorianDayOf(c.day);
    expect((await list(`?from=${day}&to=${day}`)).total).toBe(2);
    expect(
      (await as(p, 'GET', '/booking/me/appointments?from=2026-10-02&to=2026-10-01')).status,
    ).toBe(400);

    // Another patient sees none of them.
    expect((await as(await patient(), 'GET', '/booking/me/appointments')).body['total']).toBe(0);
  });
});

describe('the center panel (task 2-11): its workplaces and its list', () => {
  it('a manager sees only the workplaces of their center, with names', async () => {
    const mine = await clinic();
    const other = await clinic();
    const res = await staff(mine.manager, 'GET', '/catalog/workplaces');
    expect(res.status).toBe(200);
    const list = res.body as unknown as {
      workplaceId: string;
      doctor: { name: string };
      placeName: string;
    }[];
    expect(list.map((w) => w.workplaceId)).toEqual([mine.workplaceId]);
    expect(list[0]).toMatchObject({ doctor: { name: 'دکتر نوبت' }, placeName: 'کلینیک نوبت' });
    expect(list.map((w) => w.workplaceId)).not.toContain(other.workplaceId);
  });

  it('the workplace list names the service and masks the mobile', async () => {
    const c = await clinic();
    const p = await patient();
    await requested(p, c, 10);
    const day = gregorianDayOf(c.day);
    const res = await staff(
      c.manager,
      'GET',
      `/booking/workplaces/${c.workplaceId}/appointments?from=${day}&to=${day}`,
    );
    expect(res.status).toBe(200);
    const [one] = res.body as unknown as {
      serviceName: string;
      patient: { mobileMasked: string };
    }[];
    expect(one?.serviceName).toBe('ویزیت');
    expect(one?.patient.mobileMasked).toBe(`0${p.mobile.slice(0, 3)}***${p.mobile.slice(-4)}`);
    expect(JSON.stringify(res.body)).not.toContain(p.mobile);
  });
});

describe('who sees an appointment (rules 12 and 13)', () => {
  it('another patient and another center get 404; the doctor sees their own', async () => {
    const c = await clinic();
    const p = await patient();
    const id = (await requested(p, c, 9))['id'] as string;

    const stranger = await patient();
    expect((await as(stranger, 'GET', `/booking/me/appointments/${id}`)).status).toBe(404);
    expect(
      (await as(stranger, 'POST', `/booking/me/appointments/${id}/cancel`, reason)).status,
    ).toBe(404);
    expect((await as(stranger, 'POST', `/booking/appointments/${id}/request`)).status).toBe(404);

    const elsewhere = await clinic(dayAhead(6));
    expect((await staff(elsewhere.manager, 'GET', `/booking/appointments/${id}`)).status).toBe(404);
    expect(
      (
        await staff(elsewhere.manager, 'POST', `/booking/appointments/${id}/respond`, {
          decision: 'confirm',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await staff(
          elsewhere.doctor,
          'GET',
          `/booking/workplaces/${c.workplaceId}/appointments?from=${gregorianDayOf(c.day)}&to=${gregorianDayOf(c.day)}`,
        )
      ).status,
    ).toBe(404);

    const list = await staff(
      c.doctor,
      'GET',
      `/booking/workplaces/${c.workplaceId}/appointments?from=${gregorianDayOf(c.day)}&to=${gregorianDayOf(c.day)}`,
    );
    expect(list.status).toBe(200);
    expect((list.body as unknown as { id: string }[]).map((a) => a.id)).toEqual([id]);
    // Staff endpoints are closed to patients.
    expect((await as(p, 'GET', `/booking/appointments/${id}`)).status).toBe(403);
  });

  it('a suspended center takes no new holds and offers no slots; its appointments stay', async () => {
    const c = await clinic();
    await setMode(c, 'auto');
    const kept = await requested(await patient(), c, 9);
    const suspended = await staff(specialist, 'POST', `/catalog/centers/${c.centerId}/suspend`, {
      reason: 'تخلف',
    });
    expect(suspended.body['status']).toBe('suspended');
    const p = await patient();
    const held = await as(p, 'POST', '/booking/appointments/hold', holdBody(c, 10));
    expect(held.body['error']).toBe('workplace_not_bookable');
    const slots = await as(
      p,
      'GET',
      `/booking/workplaces/${c.workplaceId}/free-slots?from=${gregorianDayOf(c.day)}&to=${gregorianDayOf(c.day)}`,
    );
    expect(slots.body).toEqual([]);
    const { rows } = await h.owner.query<Row>('SELECT status FROM appointments WHERE id = $1', [
      kept['id'],
    ]);
    expect(rows[0]?.['status']).toBe('confirmed');
  });
});

describe('the scheduler announces once', () => {
  it('an overdue manual answer, and each reminder per offset', async () => {
    const c = await clinic(dayAhead(2));
    const sweeper = new AppointmentSweeper(
      h.app.get<Database>(DATABASE),
      h.app.get<AuditLog>(AUDIT_LOG),
      h.app.get<OutboxPort>(OUTBOX),
      h.app.get<ConfigPort>(CONFIG),
    );
    const waiting = await requested(await patient(), c, 9);
    const overdueAt = new Date(new Date(waiting['approvalDueAt'] as string).getTime() + 1000);
    await sweeper.run(overdueAt);
    await sweeper.run(overdueAt);
    expect(
      await eventsOf('booking.appointment_approval_overdue', waiting['id'] as string),
    ).toHaveLength(1);

    await setMode(c, 'auto');
    const confirmed = await requested(await patient(), c, 10);
    const dayBefore = new Date(new Date(at(c.day, 10)).getTime() - 23 * 60 * 60_000);
    await sweeper.run(dayBefore);
    await sweeper.run(dayBefore);
    const reminders = await eventsOf('booking.appointment_reminder_due', confirmed['id'] as string);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.['payload']).toMatchObject({ offsetMinutes: 1440 });
    const twoHoursBefore = new Date(new Date(at(c.day, 10)).getTime() - 90 * 60_000);
    await sweeper.run(twoHoursBefore);
    expect(
      await eventsOf('booking.appointment_reminder_due', confirmed['id'] as string),
    ).toHaveLength(2);
  });
});
