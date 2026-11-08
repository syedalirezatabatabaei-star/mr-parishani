import { randomUUID } from 'node:crypto';
import {
  buildInstallmentSchedule,
  fromJalali,
  gregorianDayOf,
  isWorkingDay,
  toJalali,
  type JalaliDate,
} from '@sepehr/contracts';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { DATABASE, type Database } from '../../src/db/database.module';
import { createPool } from '../../src/db/pool';
import { ConfigService } from '../../src/modules/config/config.service';
import { HolidayCoverageCheck } from '../../src/modules/config/holiday-coverage';
import { HolidayBatchService } from '../../src/modules/config/holiday-batch.service';
import { HolidayService } from '../../src/modules/config/holiday.service';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import {
  actorFor,
  call,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { scheduleVersionsNow } from '../repayment/rounding-version';
import { addHolidayByBatch } from './holiday-batch';

let h: Harness;
let app: Pool;
let admin: LoggedInAccount;
let admin2: LoggedInAccount;
let strategy: LoggedInAccount;
let counter = 0;
const key = (label: string) => `holiday-test-${label}-${String(++counter)}-${String(Date.now())}`;
const day = (year: number, month: number, d: number): JalaliDate => ({ year, month, day: d });

/** Owner 1405/07/27: by a batch of one day, asked by `who` and approved by another holder. */
const addHoliday = (
  who: LoggedInAccount,
  body: { on: JalaliDate; title?: string; cityCode?: string },
) => addHolidayByBatch(h, who, who === admin ? admin2 : admin, body);

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
  [admin, admin2, strategy] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, admin.id, 'ceo');
  await grantRole(h, admin2.id, 'ceo');
  await grantRole(h, strategy.id, 'strategy_manager');
});

afterAll(async () => {
  await app.end();
  await h.close();
});

describe('managing holidays', () => {
  it('the CEO adds national and city holidays; anyone may list them', async () => {
    const national = await addHoliday(admin, { on: day(1440, 1, 12), title: 'روز جمهوري' });
    expect(national.status).toBe(201);
    expect(national.body).toMatchObject({
      on: gregorianDayOf(day(1440, 1, 12)),
      kind: 'national',
      cityCode: null,
      title: 'روز جمهوری', // normalized (rule 23)
    });
    const city = await addHoliday(admin, { on: day(1440, 1, 15), cityCode: 'tabriz' });
    expect(city.body).toMatchObject({ kind: 'city', cityCode: 'tabriz' });

    const range = `from=${gregorianDayOf(day(1440, 1, 1))}&to=${gregorianDayOf(day(1440, 1, 31))}`;
    const everywhere = await call(h, 'GET', `/calendar/holidays?${range}`);
    expect(everywhere.status).toBe(200);
    expect((everywhere.body as unknown as unknown[]).length).toBe(1);
    const tabriz = await call(h, 'GET', `/calendar/holidays?${range}&cityCode=tabriz`);
    expect((tabriz.body as unknown as unknown[]).length).toBe(2);

    // The same day and scope twice is refused.
    const again = await addHoliday(admin, { on: day(1440, 1, 12) });
    expect(again.status).toBe(409);
  });

  it('is denied without config.manage_holidays, at the guard and in the service', async () => {
    expect((await addHoliday(strategy, { on: day(1440, 2, 1) })).status).toBe(403);
    const service = h.app.get(HolidayBatchService);
    const readOnly = {
      accountId: '',
      roles: [],
      permissions: new Set(['config.read'] as const),
      scopes: [],
    };
    await expect(
      service.request(actorFor(randomUUID()), readOnly, {
        year: 1440,
        days: [{ on: day(1440, 2, 1), title: 'تعطیلی' }],
        reason: 'آزمون',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner 1405/07/27: no single-day path; a day, a city's too, only by two people", async () => {
    // The one-person routes are gone.
    expect(
      (
        await call(h, 'POST', '/calendar/holidays', {
          bearer: admin.access,
          body: { on: day(1440, 3, 3), title: 'تعطیلی آزمون', reason: 'تقویم رسمی' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(h, 'DELETE', `/calendar/holidays/${randomUUID()}`, {
          bearer: admin.access,
          body: { reason: 'اشتباه' },
        })
      ).status,
    ).toBe(404);
    // A one-day batch: its asker never approves it; a second holder saves it, audited.
    const asked = await call(h, 'POST', '/calendar/holidays/batches', {
      bearer: admin.access,
      body: {
        year: 1440,
        days: [{ on: day(1440, 3, 3), title: 'تعطیلی شهر', cityCode: 'tabriz' }],
        reason: 'تقویم رسمی شهر',
      },
    });
    expect(asked.status).toBe(201);
    const id = asked.body['id'] as string;
    expect(
      (await call(h, 'POST', `/calendar/holidays/batches/${id}/approve`, { bearer: admin.access }))
        .body['error'],
    ).toBe('second_person_required');
    expect(
      (await call(h, 'POST', `/calendar/holidays/batches/${id}/approve`, { bearer: admin2.access }))
        .status,
    ).toBe(201);
    const on = gregorianDayOf(day(1440, 3, 3));
    const listed = await call(h, 'GET', `/calendar/holidays?from=${on}&to=${on}&cityCode=tabriz`);
    const saved = (listed.body as unknown as Record<string, unknown>[])[0];
    expect(saved).toMatchObject({ kind: 'city', cityCode: 'tabriz', title: 'تعطیلی شهر' });
    const audit = await h.owner.query(
      `SELECT action, reason FROM audit_events WHERE entity_type = 'holiday' AND entity_id = $1`,
      [saved?.['id']],
    );
    expect(audit.rows).toEqual([{ action: 'config.holiday_added', reason: 'تقویم رسمی شهر' }]);
    // Only national days count for contracts' due days (ADR-021), not a city's.
    const city = await call(h, 'POST', '/calendar/holidays/batches', {
      bearer: admin.access,
      body: {
        year: 1440,
        days: [{ on: day(1440, 3, 4), title: 'تعطیلی شهر', cityCode: 'tabriz' }],
        reason: 'شهر',
      },
    });
    expect(city.body['affectedContractsAtRequest']).toBe(0);
    await call(h, 'POST', `/calendar/holidays/batches/${city.body['id'] as string}/reject`, {
      bearer: admin2.access,
    });
  });

  it("owner 1405/08/02: holidays are the CEO's; the system admin neither asks nor decides; the deputy only decides", async () => {
    // 0105: the system admin's grant ended; the deputy's role holds the approval alone.
    const sysadmin = await loggedInAccount(h, 'staff');
    await grantRole(h, sysadmin.id, 'system_admin');
    const deputy = await loggedInAccount(h, 'staff');
    await grantRole(h, deputy.id, 'holiday_deputy');
    const { rows: deputyGrants } = await h.owner.query<{ permission_code: string }>(
      `SELECT rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'holiday_deputy' AND rp.deleted_at IS NULL`,
    );
    expect(deputyGrants.map((g) => g.permission_code)).toEqual(['config.approve_holidays']);
    const batch = {
      year: 1442,
      days: [{ on: day(1442, 5, 5), title: 'تعطیلی آزمون' }],
      reason: 'تقویم رسمی',
    };
    const ask = (who: LoggedInAccount) =>
      call(h, 'POST', '/calendar/holidays/batches', { bearer: who.access, body: batch });
    const decide = (who: LoggedInAccount, id: string, how: 'approve' | 'reject') =>
      call(h, 'POST', `/calendar/holidays/batches/${id}/${how}`, { bearer: who.access });

    // The system admin: no asking, no list, no deciding.
    expect((await ask(sysadmin)).status).toBe(403);
    expect(
      (await call(h, 'GET', '/calendar/holidays/batches', { bearer: sysadmin.access })).status,
    ).toBe(403);
    // The deputy asks for nothing, adding or removing.
    expect((await ask(deputy)).status).toBe(403);
    expect(
      (
        await call(h, 'POST', '/calendar/holidays/removals', {
          bearer: deputy.access,
          body: { holidayId: randomUUID(), reason: 'اشتباه' },
        })
      ).status,
    ).toBe(403);
    // The CEO asks; the system admin may not decide it; the deputy does.
    const asked = await ask(admin);
    expect(asked.status).toBe(201);
    const id = asked.body['id'] as string;
    expect((await decide(sysadmin, id, 'approve')).status).toBe(403);
    const waiting = await call(h, 'GET', '/calendar/holidays/batches', { bearer: deputy.access });
    expect(waiting.status).toBe(200);
    expect((waiting.body as unknown as { id: string }[]).map((b) => b.id)).toContain(id);
    expect((await decide(deputy, id, 'approve')).status).toBe(201);
    const on = gregorianDayOf(day(1442, 5, 5));
    const listed = await call(h, 'GET', `/calendar/holidays?from=${on}&to=${on}`);
    expect(listed.body).toMatchObject([{ title: 'تعطیلی آزمون' }]);
    // The grant on the role itself: the CEO's, no longer the system admin's.
    const { rows } = await h.owner.query<{ code: string }>(
      `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission_code = 'config.manage_holidays' AND rp.deleted_at IS NULL ORDER BY 1`,
    );
    expect(rows.map((r) => r.code)).toEqual(['ceo']);
  });

  it('the database refuses edits, physical deletes and a city on a national holiday', async () => {
    const created = await addHoliday(admin, { on: day(1440, 4, 4) });
    const id = created.body['id'] as string;
    await expect(
      app.query(`UPDATE holidays SET title = 'دیگر' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('DELETE FROM holidays WHERE id = $1', [id])).rejects.toBeTruthy();
    await expect(h.owner.query('DELETE FROM holidays WHERE id = $1', [id])).rejects.toBeTruthy();
    await expect(
      app.query(
        `INSERT INTO holidays (holiday_on, title, kind, city_code) VALUES ('2061-01-01', 'آزمون', 'national', 'tehran')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the Bahman notice (task 2-1 decision: panel + log, weekly)', () => {
  it('opens from 1 Bahman while next year has no national holiday, repeats weekly, resolves', async () => {
    const check = new HolidayCoverageCheck(h.app.get<Database>(DATABASE));
    const at = (d: JalaliDate) => fromJalali(d, { hour: 9 });
    expect((await addHoliday(admin, { on: day(1449, 1, 1) })).status).toBe(201);

    // Before Bahman only the current year counts, and it has a holiday.
    expect(await check.run(at(day(1449, 10, 30)))).toEqual({ missingYears: [], notice: 'none' });
    expect(await check.run(at(day(1449, 11, 1)))).toEqual({
      missingYears: [1450],
      notice: 'raised',
    });

    const notices = await call(h, 'GET', '/config/notices', { bearer: admin.access });
    expect(notices.status).toBe(200);
    expect(notices.body).toEqual([
      expect.objectContaining({ code: 'holidays_missing', raiseCount: 1 }),
    ]);
    const message = (notices.body as unknown as { message: string }[])[0]?.message ?? '';
    expect(message).toContain('سال ۱۴۵۰');
    // Shown as it is in the panel: Persian digits only.
    expect(message).not.toMatch(/[0-9]/);
    // Only for whoever manages holidays.
    const other = await call(h, 'GET', '/config/notices', { bearer: strategy.access });
    expect(other.body).toEqual([]);

    expect((await check.run(at(day(1449, 11, 3)))).notice).toBe('open');
    expect((await check.run(at(day(1449, 11, 8)))).notice).toBe('raised');
    const { rows } = await h.owner.query(
      `SELECT raise_count FROM admin_notices WHERE code = 'holidays_missing' AND resolved_at IS NULL`,
    );
    expect(rows).toEqual([{ raise_count: 2 }]);

    // A city holiday is not enough; a national one resolves it.
    await addHoliday(admin, { on: day(1450, 1, 13), cityCode: 'shiraz' });
    expect((await check.run(at(day(1449, 11, 9)))).notice).toBe('open');
    await addHoliday(admin, { on: day(1450, 1, 13) });
    expect(await check.run(at(day(1449, 11, 10)))).toEqual({
      missingYears: [],
      notice: 'resolved',
    });
    expect((await call(h, 'GET', '/config/notices', { bearer: admin.access })).body).toEqual([]);
  });
});

describe('installment due dates on holidays (task 2-1 acceptance)', () => {
  const principal = 12_000_000n;
  const count = 6;

  async function fundedPurse() {
    const wallet = h.app.get(WalletService);
    const approved = await wallet.approveCredit(CLI_ACTOR, {
      idempotencyKey: key('approve'),
      caseId: randomUUID(),
      borrowerPersonId: randomUUID(),
      amountRial: principal,
      scope: {
        centerNodeId: randomUUID(),
        doctorNodeId: randomUUID(),
        treatmentFieldCode: 'dental',
      },
    });
    await wallet.charge(CLI_ACTOR, approved.purseId, { idempotencyKey: key('charge') });
    const summary = await wallet.summary(approved.purseId);
    if (!summary.fundedAt) throw new Error('not funded');
    return { purseId: approved.purseId, fundedAt: summary.fundedAt };
  }

  const schedule = async (purseId: string) =>
    h.app
      .get(RepaymentService)
      .createSchedule(CLI_ACTOR, {
        idempotencyKey: key('schedule'),
        purseId,
        installmentCount: count,
        planFeeRial: 0n,
        ...(await scheduleVersionsNow(h)),
      })
      .then(({ scheduleId }) => h.app.get(RepaymentService).schedule(scheduleId));

  it('off: no schedule changes; on: the due day moves to the next working day, total unchanged', async () => {
    const first = await fundedPurse();
    const nominal = buildInstallmentSchedule({
      totalRial: principal,
      count,
      fundedAt: first.fundedAt,
      roundingUnitRial: 10_000n,
    });
    const firstDue = nominal[0]?.dueJalali ?? day(1400, 1, 1);
    // A national holiday on the first due day, and a Tabriz-only holiday on the day after
    // it: installments ignore city holidays (task 2-1 decision).
    expect((await addHoliday(admin, { on: firstDue })).status).toBe(201);
    const nextDay = toJalali(new Date(fromJalali(firstDue, { hour: 12 }).getTime() + 86_400_000));
    await addHoliday(admin, { on: nextDay, cityCode: 'tabriz' });

    // Off (the default): the schedule is exactly the nominal one.
    const off = await schedule(first.purseId);
    expect(off.dueDatesShifted).toBe(false);
    expect(off.installments.map((i) => i.dueOn)).toEqual(nominal.map((i) => i.dueOn));

    // Turned on by two people.
    const config = h.app.get(ConfigService);
    const manage = {
      accountId: '',
      roles: [],
      permissions: new Set(['config.manage_business'] as const),
      scopes: [],
    };
    const proposal = await config.propose(actorFor(randomUUID()), manage, {
      key: 'repayment.shift_due_to_next_working_day',
      scope: { level: 'global' },
      value: true,
      reason: 'جابه‌جایی سررسید در تعطیلی',
    });
    await config.decide(actorFor(randomUUID()), manage, proposal.id, true);

    const second = await fundedPurse();
    const on = await schedule(second.purseId);
    expect(on.dueDatesShifted).toBe(true);
    // Same amounts, same total; only dates moved, and only forward.
    expect(on.installments.map((i) => i.amountRial)).toEqual(
      off.installments.map((i) => i.amountRial),
    );
    expect(on.installments.reduce((s, i) => s + i.amountRial, 0n)).toBe(principal);
    expect(on.totalRial).toBe(off.totalRial);
    const calendar = await h.app.get(HolidayService).calendarFor({
      from: nominal[0]?.dueOn ?? '',
      to: gregorianDayOf(day(1500, 1, 1)),
      cityCode: null,
    });
    on.installments.forEach((installment, i) => {
      const nominalDue = nominal[i]?.dueOn ?? '';
      expect(installment.dueOn >= nominalDue).toBe(true);
      expect(
        isWorkingDay(toJalali(new Date(`${installment.dueOn}T12:00:00Z`)), null, calendar.calendar),
      ).toBe(true);
    });
    expect(on.installments[0]?.dueOn).not.toBe(nominal[0]?.dueOn);
    // The day after the national holiday is a Tabriz holiday only: it still counts, unless
    // it is a Friday.
    const expected = isWorkingDay(nextDay, null, calendar.calendar)
      ? gregorianDayOf(nextDay)
      : null;
    if (expected) expect(on.installments[0]?.dueOn).toBe(expected);

    // Rule 16: the schedule made while it was off is untouched, and the new one records
    // the versions that decided it.
    const offAgain = await h.app.get(RepaymentService).schedule(off.id);
    expect(offAgain.installments.map((i) => i.dueOn)).toEqual(nominal.map((i) => i.dueOn));
    const { rows } = await h.owner.query(
      `SELECT due_dates_shifted, shift_config_version_id, weekly_days_off_config_version_id
       FROM installment_schedules WHERE id = ANY($1) ORDER BY due_dates_shifted`,
      [[off.id, on.id]],
    );
    expect(rows[0]).toMatchObject({
      due_dates_shifted: false,
      weekly_days_off_config_version_id: null,
    });
    expect(rows[1]).toMatchObject({
      due_dates_shifted: true,
      shift_config_version_id: proposal.id,
      weekly_days_off_config_version_id: calendar.weeklyDaysOffVersionId,
    });
  });
});
