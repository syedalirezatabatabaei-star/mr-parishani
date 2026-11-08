import { randomUUID } from 'node:crypto';
import {
  buildInstallmentSchedule,
  gregorianDayOf,
  toJalali,
  type JalaliDate,
} from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { DATABASE, type Database } from '../../src/db/database.module';
import { HolidayService } from '../../src/modules/config/holiday.service';
import { ConfigService } from '../../src/modules/config/config.service';
import { HolidaySuggestionService } from '../../src/modules/config/holiday-suggestion.service';
import { jalaliDay } from '../../src/modules/contract/contract.service';
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

/**
 * Suggested official holidays (owner 1405/07/23 and 07/24, plan 3, f5; ADR-043; migration
 * 0088): a preview that writes nothing, seeded with the fixed solar days only; what the admin
 * then saves, one day at a time, never writes over a holiday there is and never changes a
 * schedule already built.
 */

type Row = Record<string, unknown>;
interface Day {
  on: string;
  jalali: JalaliDate;
  title: string;
  estimated: boolean;
  existing: boolean;
}

let h: Harness;
let admin: LoggedInAccount;
/** A second holder (a CEO in tests): the batch's second person. */
let admin2: LoggedInAccount;
let strategy: LoggedInAccount;
let counter = 0;
const key = (label: string) => `suggest-${label}-${String(++counter)}-${String(Date.now())}`;
const manage = {
  accountId: '',
  roles: [],
  permissions: new Set(['config.manage_business'] as const),
  scopes: [],
};

const suggestions = (who: LoggedInAccount, year: number) =>
  call(h, 'GET', `/calendar/holidays/suggestions?year=${String(year)}`, { bearer: who.access });
const daysOf = (body: Row) => body['days'] as Day[];
/** Owner 1405/07/27: a day saved by a one-day batch, asked by one admin, approved by another. */
const addHoliday = (on: JalaliDate, title = 'تعطیلی آزمون') =>
  addHolidayByBatch(h, admin, admin2, { on, title, reason: 'پس از اعلام رسمی' });

/** A config change by two people (the key is sensitive). */
async function approve(key: string, value: unknown) {
  const config = h.app.get(ConfigService);
  const proposal = await config.propose(actorFor(randomUUID()), manage, {
    key: key as never,
    scope: { level: 'global' },
    value: value,
    reason: 'آزمون نقشه ۳',
  });
  await config.decide(actorFor(randomUUID()), manage, proposal.id, true);
  return proposal.id;
}

const rulesNow = async () =>
  (await h.app.get(ConfigService).resolve('calendar.holiday_rules')).value;

const counts = async () =>
  (
    await h.owner.query<Row>(`
      SELECT (SELECT count(*)::int FROM holidays) AS holidays,
             (SELECT count(*)::int FROM audit_events) AS audits,
             (SELECT count(*)::int FROM config_values) AS config_values,
             (SELECT count(*)::int FROM outbox_events) AS outbox`)
  ).rows[0];

let sequence = 900_000;
/** A live contract, not a sample unless asked, printing one due day (as contract.service). */
async function contract(due: JalaliDate, sample = false) {
  const { rows: template } = await h.owner.query<Row>(
    `SELECT id FROM config_values WHERE key = 'contract.loan_template' AND status = 'approved' LIMIT 1`,
  );
  const applicationId = randomUUID();
  const table = JSON.stringify([
    { index: '۱', dueOn: jalaliDay(gregorianDayOf(due)), amount: '۱٬۰۰۰' },
  ]);
  sequence += 1;
  await h.owner.query(
    `INSERT INTO contracts (credit_application_id, entity_id, jalali_year, sequence, number,
       template_version_id, fields, sample, parties, created_by)
     VALUES ($1, 'aramesh', 1440, $2, $3, $4, $5::jsonb, $6, '[]'::jsonb, $7)`,
    [
      applicationId,
      sequence,
      `1440-${String(sequence)}`,
      template[0]?.['id'],
      JSON.stringify({ 'installments.table': table }),
      sample,
      admin.id,
    ],
  );
  return applicationId;
}

beforeAll(async () => {
  h = await startHarness();
  [admin, admin2, strategy] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, admin.id, 'ceo');
  await grantRole(h, admin2.id, 'ceo');
  await grantRole(h, strategy.id, 'strategy_manager');
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('the preview of a year (plan 3, ADR-043)', () => {
  it('0088 seeds the seven solar occasions, ten days, no lunar day', async () => {
    const rules = await rulesNow();
    expect(rules.lunar).toEqual([]);
    expect(rules.solar.map((r) => `${String(r.month)}/${String(r.day)}`)).toEqual([
      '1/1',
      '1/2',
      '1/3',
      '1/4',
      '1/12',
      '1/13',
      '3/14',
      '3/15',
      '11/22',
      '12/29',
    ]);
  });

  it('lays the rules on the year, marks a day entered already, and writes nothing', async () => {
    const before = await counts();
    const first = await suggestions(admin, 1440);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await counts()).toEqual(before);
    const version = await h.app.get(ConfigService).resolve('calendar.holiday_rules');
    expect(first.body).toMatchObject({
      year: 1440,
      rulesVersionId: version.versionId,
      contractsWithDueOnNewDays: 0,
    });
    const days = daysOf(first.body);
    expect(days).toHaveLength(10);
    expect(days.every((d) => !d.estimated && !d.existing)).toBe(true);
    expect(days[0]).toMatchObject({
      on: gregorianDayOf({ year: 1440, month: 1, day: 1 }),
      title: 'عید نوروز',
    });

    // Entered by the admin: marked, not offered again.
    expect((await addHoliday({ year: 1440, month: 1, day: 1 }, 'نوروز')).status).toBe(201);
    const again = daysOf((await suggestions(admin, 1440)).body);
    expect(again.filter((d) => d.existing).map((d) => d.on)).toEqual([
      gregorianDayOf({ year: 1440, month: 1, day: 1 }),
    ]);
  });

  it('is denied without config.manage_holidays, at the guard and in the service', async () => {
    expect((await suggestions(strategy, 1440)).status).toBe(403);
    const readOnly = {
      accountId: '',
      roles: [],
      permissions: new Set(['config.read'] as const),
      scopes: [],
    };
    await expect(h.app.get(HolidaySuggestionService).forYear(readOnly, 1440)).rejects.toMatchObject(
      { status: 403 },
    );
    expect((await suggestions(admin, 1399)).status).toBe(400);
  });

  it('lunar rules, added by two people, come as estimates', async () => {
    const rules = await rulesNow();
    await approve('calendar.holiday_rules', {
      ...rules,
      lunar: [{ month: 10, day: 1, title: 'عید سعید فطر' }],
    });
    const days = daysOf((await suggestions(admin, 1440)).body);
    const lunar = days.filter((d) => d.estimated);
    expect(lunar.length).toBeGreaterThan(0);
    expect(lunar.every((d) => d.title.includes('عید سعید فطر'))).toBe(true);
    expect(days.filter((d) => !d.estimated)).toHaveLength(10);
    await approve('calendar.holiday_rules', rules);
  });

  it('(a) counts contracts not funded whose printed due day is a new day', async () => {
    const newDay = { year: 1440, month: 1, day: 12 };
    await contract(newDay); // counted
    await contract(newDay, true); // a sample: not
    await contract({ year: 1440, month: 1, day: 1 }); // on a day entered already: not
    await contract({ year: 1440, month: 2, day: 2 }); // on no suggested day: not
    // Funded: its schedule is built and never changes.
    const funded = await contract(newDay);
    await h.app.get(WalletService).approveCredit(CLI_ACTOR, {
      idempotencyKey: key('approve'),
      caseId: randomUUID(),
      creditApplicationId: funded,
      borrowerPersonId: randomUUID(),
      amountRial: 1_000_000n,
      scope: {
        centerNodeId: randomUUID(),
        doctorNodeId: randomUUID(),
        treatmentFieldCode: 'dental',
      },
    });
    const view = await suggestions(admin, 1440);
    expect(view.body['contractsWithDueOnNewDays']).toBe(1);
  });
});

describe('what the admin saves changes no schedule built (plan 3 invariants)', () => {
  const principal = 12_000_000n;
  const count = 6;

  async function fundedSchedule() {
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
    const repayment = h.app.get(RepaymentService);
    const { scheduleId } = await repayment.createSchedule(CLI_ACTOR, {
      idempotencyKey: key('schedule'),
      purseId: approved.purseId,
      installmentCount: count,
      planFeeRial: 0n,
      ...(await scheduleVersionsNow(h)),
    });
    return repayment.schedule(scheduleId);
  }

  const stored = async (scheduleId: string) =>
    (
      await h.owner.query<Row>(
        `SELECT index, to_char(due_on, 'YYYY-MM-DD') AS due_on, amount_rial::text AS amount
         FROM installments WHERE schedule_id = $1 ORDER BY index`,
        [scheduleId],
      )
    ).rows;

  it('a day entered already is refused, never written over', async () => {
    const on = { year: 1441, month: 1, day: 13 };
    const first = await addHoliday(on, 'روز طبیعت');
    expect(first.status).toBe(201);
    const second = await addHoliday(on, 'عنوان دیگر');
    expect(second.status).toBe(409);
    expect(second.body['error']).toBe('holiday_exists');
    const { rows } = await h.owner.query<Row>(
      `SELECT id, title, deleted_at FROM holidays WHERE holiday_on = $1::date`,
      [gregorianDayOf(on)],
    );
    expect(rows).toEqual([{ id: first.body['id'], title: 'روز طبیعت', deleted_at: null }]);
  });

  it('built before: unchanged row by row; after, shift off: as without holidays; shift on: only dates move', async () => {
    // Built before the save, with the shift on for the case, so a re-read would show.
    await approve('repayment.shift_due_to_next_working_day', true);
    const before = await fundedSchedule();
    const beforeRows = await stored(before.id);
    await approve('repayment.shift_due_to_next_working_day', false);

    // The days the new holidays fall on: every due day of a schedule funded now.
    const nominal = buildInstallmentSchedule({
      totalRial: principal,
      count,
      fundedAt: before.fundedAt,
      roundingUnitRial: before.roundingUnitRial,
    });
    const dueDays = nominal.map((i) => toJalali(new Date(`${i.dueOn}T12:00:00Z`)));
    const rules = await rulesNow();
    const taken = new Set(rules.solar.map((r) => `${String(r.month)}/${String(r.day)}`));
    const added = dueDays
      .filter((d) => !taken.has(`${String(d.month)}/${String(d.day)}`))
      .map((d) => ({ month: d.month, day: d.day, title: 'تعطیلی آزمون نقشه ۳' }));
    await approve('calendar.holiday_rules', { ...rules, solar: [...rules.solar, ...added] });

    // The admin saves, from the preview, each new day of each year the schedule runs in.
    const years = [...new Set(dueDays.map((d) => d.year))];
    for (const year of years) {
      for (const day of daysOf((await suggestions(admin, year)).body)) {
        if (!day.existing) expect((await addHoliday(day.jalali, day.title)).status).toBe(201);
      }
    }
    const view = await suggestions(admin, years[0] ?? 0);
    expect(daysOf(view.body).every((d) => d.existing)).toBe(true);

    // (1) The schedule built before: row by row as it was, in the table and as read.
    expect(await stored(before.id)).toEqual(beforeRows);
    const reread = await h.app.get(RepaymentService).schedule(before.id);
    expect(reread.installments.map((i) => i.dueOn)).toEqual(
      before.installments.map((i) => i.dueOn),
    );

    // (2) Shift off: a schedule funded after is the one without holidays.
    const off = await fundedSchedule();
    expect(off.dueDatesShifted).toBe(false);
    expect(off.installments.map((i) => i.dueOn)).toEqual(nominal.map((i) => i.dueOn));

    // (3) Shift on: only dates move, forward; count, each amount and the total as without.
    await approve('repayment.shift_due_to_next_working_day', true);
    const on = await fundedSchedule();
    expect(on.dueDatesShifted).toBe(true);
    expect(on.installments).toHaveLength(off.installments.length);
    expect(on.installments.map((i) => i.amountRial)).toEqual(
      off.installments.map((i) => i.amountRial),
    );
    expect(on.totalRial).toBe(off.totalRial);
    on.installments.forEach((installment, i) => {
      expect(installment.dueOn > (nominal[i]?.dueOn ?? '')).toBe(true);
    });

    // And still: neither earlier schedule changed.
    expect(await stored(before.id)).toEqual(beforeRows);
    expect(
      (await h.app.get(RepaymentService).schedule(off.id)).installments.map((i) => i.dueOn),
    ).toEqual(nominal.map((i) => i.dueOn));
  });
});

describe('holidays saved together, by two people, all or none (owner 1405/07/24)', () => {
  const asBatch = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
    call(h, method, `/calendar/holidays/batches${path}`, {
      bearer: who.access,
      ...(body === undefined ? {} : { body }),
    });
  const ask = (who: LoggedInAccount, year: number, days: [number, number, string][]) =>
    asBatch(who, 'POST', '', {
      year,
      days: days.map(([month, day, title]) => ({ on: { year, month, day }, title })),
      reason: 'تقویم رسمی سال',
    });
  const savedOn = async (year: number) =>
    (
      await h.owner.query<Row>(
        `SELECT to_char(holiday_on, 'YYYY-MM-DD') AS on, title FROM holidays
         WHERE deleted_at IS NULL AND holiday_on BETWEEN $1::date AND $2::date ORDER BY 1`,
        [gregorianDayOf({ year, month: 1, day: 1 }), gregorianDayOf({ year, month: 12, day: 29 })],
      )
    ).rows;
  const auditCount = async (action: string, entityId: string) =>
    (
      await h.owner.query<Row>(
        `SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND entity_id::text = $2`,
        [action, entityId],
      )
    ).rows[0]?.['n'];

  it('asked by one, approved by a second: every day saved together; the count shown to both', async () => {
    await contract({ year: 1442, month: 1, day: 12 });
    const asked = await ask(admin, 1442, [
      [1, 12, 'روز جمهوری اسلامی'],
      [1, 13, 'روز طبیعت'],
    ]);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({
      year: 1442,
      status: 'pending',
      requestedByMe: true,
      affectedContractsAtRequest: 1,
      affectedContractsNow: 1,
      savedCount: null,
    });
    const id = asked.body['id'] as string;
    expect(await savedOn(1442)).toEqual([]);

    // A contract printed since: the approver sees the count of now, before saving.
    await contract({ year: 1442, month: 1, day: 13 });
    const listed = await asBatch(admin2, 'GET', '');
    expect(listed.status).toBe(200);
    expect(listed.body as unknown as Row[]).toEqual([
      expect.objectContaining({
        id,
        requestedByMe: false,
        affectedContractsAtRequest: 1,
        affectedContractsNow: 2,
      }),
    ]);

    // Never the asker.
    const own = await asBatch(admin, 'POST', `/${id}/approve`);
    expect(own.status).toBe(403);
    expect(own.body['error']).toBe('second_person_required');
    expect(await savedOn(1442)).toEqual([]);

    const done = await asBatch(admin2, 'POST', `/${id}/approve`);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({
      status: 'approved',
      savedCount: 2,
      affectedContractsNow: null,
    });
    expect(await savedOn(1442)).toEqual([
      { on: gregorianDayOf({ year: 1442, month: 1, day: 12 }), title: 'روز جمهوری اسلامی' },
      { on: gregorianDayOf({ year: 1442, month: 1, day: 13 }), title: 'روز طبیعت' },
    ]);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM audit_events a JOIN holidays h ON h.id::text = a.entity_id::text
       WHERE a.action = 'config.holiday_added' AND a.reason = 'تقویم رسمی سال'
         AND h.holiday_on BETWEEN $1::date AND $2::date`,
      [
        gregorianDayOf({ year: 1442, month: 1, day: 1 }),
        gregorianDayOf({ year: 1442, month: 1, day: 31 }),
      ],
    );
    expect(rows[0]?.['n']).toBe(2);
    expect(await auditCount('config.holiday_batch_requested', id)).toBe(1);
    expect(await auditCount('config.holiday_batch_approved', id)).toBe(1);
    expect((await asBatch(admin2, 'POST', `/${id}/approve`)).body['error']).toBe('already_decided');
  });

  it('all or none: a day entered since refuses the whole batch; nothing is written over', async () => {
    const id = (
      await ask(admin, 1443, [
        [1, 1, 'عید نوروز'],
        [1, 12, 'روز جمهوری اسلامی'],
        [1, 13, 'روز طبیعت'],
      ])
    ).body['id'] as string;
    // Entered meanwhile, with its own title. Owner 1405/07/27: no single-day path, and the
    // year's one open batch is this one, so the day comes in through the service's own path.
    await h.app.get<Database>(DATABASE).transaction((tx) =>
      h.app.get(HolidayService).addInTransaction(tx, CLI_ACTOR, {
        on: { year: 1443, month: 1, day: 13 },
        title: 'سیزده به در',
        reason: 'پس از اعلام رسمی',
      }),
    );
    const before = await savedOn(1443);
    expect(before).toEqual([
      { on: gregorianDayOf({ year: 1443, month: 1, day: 13 }), title: 'سیزده به در' },
    ]);

    const refused = await asBatch(admin2, 'POST', `/${id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'holiday_exists',
      on: gregorianDayOf({ year: 1443, month: 1, day: 13 }),
    });
    // None of the batch saved, the one there untouched, the batch still waiting.
    expect(await savedOn(1443)).toEqual(before);
    const { rows } = await h.owner.query<Row>(`SELECT status FROM holiday_batches WHERE id = $1`, [
      id,
    ]);
    expect(rows[0]?.['status']).toBe('pending');
    expect((await asBatch(admin2, 'POST', `/${id}/reject`)).status).toBe(201);

    // Asked with a day there already: refused at once.
    const late = await ask(admin, 1443, [[1, 13, 'روز طبیعت']]);
    expect(late.status).toBe(409);
    expect(late.body['error']).toBe('holiday_exists');
  });

  it('rejected: nothing saved; one open batch a year; by permission; one year; the database holds the rule', async () => {
    const asked = await ask(admin, 1444, [[11, 22, 'پیروزی انقلاب اسلامی']]);
    expect(asked.status).toBe(201);
    const id = asked.body['id'] as string;
    expect((await ask(admin2, 1444, [[3, 14, 'رحلت امام خمینی']])).body['error']).toBe(
      'batch_open',
    );
    expect((await ask(strategy, 1445, [[3, 14, 'رحلت امام خمینی']])).status).toBe(403);
    expect((await asBatch(strategy, 'GET', '')).status).toBe(403);
    expect((await asBatch(strategy, 'POST', `/${id}/approve`)).status).toBe(403);
    const outside = await asBatch(admin, 'POST', '', {
      year: 1445,
      days: [{ on: { year: 1446, month: 1, day: 1 }, title: 'عید نوروز' }],
      reason: 'تقویم رسمی سال',
    });
    expect(outside.status).toBe(400);

    const rejected = await asBatch(admin2, 'POST', `/${id}/reject`);
    expect(rejected.body).toMatchObject({ status: 'rejected', savedCount: null });
    expect(await savedOn(1444)).toEqual([]);
    expect(await auditCount('config.holiday_batch_rejected', id)).toBe(1);

    // The database: no decision by the asker, and a decision is final.
    const again = (await ask(admin, 1444, [[3, 15, 'قیام پانزده خرداد']])).body['id'] as string;
    await expect(
      h.owner.query(
        `UPDATE holiday_batches SET status = 'rejected', decided_by = requested_by,
           decided_at = now() WHERE id = $1`,
        [again],
      ),
    ).rejects.toThrow(/two_people_check/);
    await expect(
      h.owner.query(`UPDATE holiday_batches SET status = 'pending' WHERE id = $1`, [id]),
    ).rejects.toThrow(/a decided batch does not change/);
    await expect(
      h.owner.query(`UPDATE holiday_batches SET reason = 'دلیل دیگر برای آزمون' WHERE id = $1`, [
        again,
      ]),
    ).rejects.toThrow(/what was asked does not change/);
  });
});
