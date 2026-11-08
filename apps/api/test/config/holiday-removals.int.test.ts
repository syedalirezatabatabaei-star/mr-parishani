import { randomUUID } from 'node:crypto';
import { gregorianDayOf, type JalaliDate } from '@sepehr/contracts';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/db/pool';
import { HolidayRemovalService } from '../../src/modules/config/holiday-removal.service';
import { HolidaySuggestionService } from '../../src/modules/config/holiday-suggestion.service';
import {
  actorFor,
  call,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { addHolidayByBatch } from './holiday-batch';

/**
 * A holiday taken off the calendar by two people (owner 1405/07/29; ADR-043; migration 0099):
 * one holder of config.manage_holidays asks with a reason, a second, never the asker, approves
 * (a soft delete, rule 7, audited with the reason) or rejects; one open request per holiday; the
 * database holds the two-person rule and keeps a decided request as it was.
 */

type Row = Record<string, unknown>;

let h: Harness;
let app: Pool;
let admin: LoggedInAccount;
let admin2: LoggedInAccount;
let strategy: LoggedInAccount;
const day = (year: number, month: number, d: number): JalaliDate => ({ year, month, day: d });

const addHoliday = async (on: JalaliDate, cityCode?: string) => {
  const saved = await addHolidayByBatch(h, admin, admin2, {
    on,
    title: 'تعطیلی آزمون',
    ...(cityCode ? { cityCode } : {}),
  });
  expect(saved.status).toBe(201);
  return saved.body['id'] as string;
};
const ask = (who: LoggedInAccount, holidayId: string, reason = 'اعلام اشتباه تقویم') =>
  call(h, 'POST', '/calendar/holidays/removals', {
    bearer: who.access,
    body: { holidayId, reason },
  });
const decide = (who: LoggedInAccount, id: string, decision: 'approve' | 'reject') =>
  call(h, 'POST', `/calendar/holidays/removals/${id}/${decision}`, { bearer: who.access });
const listed = async (on: JalaliDate, cityCode?: string) => {
  const d = gregorianDayOf(on);
  const city = cityCode ? `&cityCode=${cityCode}` : '';
  const res = await call(h, 'GET', `/calendar/holidays?from=${d}&to=${d}${city}`);
  return res.body as unknown as Row[];
};

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

describe('removing a holiday: two people (owner 1405/07/29)', () => {
  it('asked by one, removed only once a second approves; audited with the reason', async () => {
    const on = day(1441, 2, 2);
    const holidayId = await addHoliday(on);
    const asked = await ask(admin, holidayId, 'روز اشتباه وارد شد');
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({
      holidayId,
      on: gregorianDayOf(on),
      cityCode: null,
      status: 'pending',
      requestedByMe: true,
    });
    const id = asked.body['id'] as string;
    // Still on the calendar while it waits.
    expect(await listed(on)).toHaveLength(1);

    // The asker never decides it.
    const self = await decide(admin, id, 'approve');
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('second_person_required');
    expect(await listed(on)).toHaveLength(1);

    // The second holder sees it waiting, with the count now, and approves.
    const waiting = await call(h, 'GET', '/calendar/holidays/removals', { bearer: admin2.access });
    const mine = (waiting.body as unknown as Row[]).find((r) => r['id'] === id);
    expect(mine).toMatchObject({ requestedByMe: false, affectedContractsNow: 0 });
    const approved = await decide(admin2, id, 'approve');
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'approved', affectedContractsNow: null });
    expect(await listed(on)).toHaveLength(0);

    // A soft delete (rule 7), by the approver, audited with the request's reason.
    const kept = await h.owner.query(
      'SELECT deleted_at IS NOT NULL AS removed, deleted_by FROM holidays WHERE id = $1',
      [holidayId],
    );
    expect(kept.rows).toEqual([{ removed: true, deleted_by: admin2.id }]);
    const audit = await h.owner.query(
      `SELECT action, reason FROM audit_events
       WHERE (entity_type = 'holiday' AND entity_id = $1)
          OR (entity_type = 'holiday_removal' AND entity_id = $2)
       ORDER BY seq`,
      [holidayId, id],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        { action: 'config.holiday_removal_requested', reason: 'روز اشتباه وارد شد' },
        { action: 'config.holiday_removed', reason: 'روز اشتباه وارد شد' },
        { action: 'config.holiday_removal_approved', reason: 'روز اشتباه وارد شد' },
      ]),
    );

    // Decided once; a removed holiday cannot be asked again.
    expect((await decide(admin2, id, 'reject')).body['error']).toBe('already_decided');
    expect((await ask(admin, holidayId)).status).toBe(404);
  });

  it("a rejection removes nothing; a city's holiday counts no contract", async () => {
    const on = day(1441, 2, 9);
    const holidayId = await addHoliday(on, 'tabriz');
    const asked = await ask(admin2, holidayId);
    expect(asked.body).toMatchObject({ cityCode: 'tabriz', affectedContractsAtRequest: 0 });
    const id = asked.body['id'] as string;
    expect((await decide(admin2, id, 'reject')).status).toBe(403);
    const rejected = await decide(admin, id, 'reject');
    expect(rejected.status).toBe(201);
    expect(rejected.body['status']).toBe('rejected');
    expect(await listed(on, 'tabriz')).toHaveLength(1);
    // Asked again after a rejection: a new request.
    const again = await ask(admin, holidayId);
    expect(again.status).toBe(201);
    await decide(admin2, again.body['id'] as string, 'reject');
  });

  it("only a national holiday counts plan 3 (a)'s contracts, when asked and now", async () => {
    const national = await addHoliday(day(1441, 2, 16));
    const city = await addHoliday(day(1441, 2, 17), 'tabriz');
    // The count itself is plan 3 (a)'s (holiday-suggestions tests); here only what is asked.
    const count = vi
      .spyOn(h.app.get(HolidaySuggestionService), 'affectedContracts')
      .mockResolvedValue(3);
    try {
      const asked = await ask(admin, national);
      expect(asked.body).toMatchObject({ affectedContractsAtRequest: 3, affectedContractsNow: 3 });
      expect(count).toHaveBeenCalledWith([gregorianDayOf(day(1441, 2, 16))]);
      const local = await ask(admin, city);
      expect(local.body).toMatchObject({ affectedContractsAtRequest: 0, affectedContractsNow: 0 });
      await decide(admin2, asked.body['id'] as string, 'reject');
      await decide(admin2, local.body['id'] as string, 'reject');
    } finally {
      count.mockRestore();
    }
  });

  it('one open request per holiday; an unknown holiday is refused', async () => {
    const holidayId = await addHoliday(day(1441, 3, 3));
    const first = await ask(admin, holidayId);
    expect(first.status).toBe(201);
    const second = await ask(admin2, holidayId);
    expect(second.status).toBe(409);
    expect(second.body['error']).toBe('removal_open');
    expect((await ask(admin, randomUUID())).status).toBe(404);
    await decide(admin2, first.body['id'] as string, 'reject');
  });

  it('is denied without config.manage_holidays, at the guard and in the service', async () => {
    const holidayId = await addHoliday(day(1441, 3, 10));
    expect((await ask(strategy, holidayId)).status).toBe(403);
    expect(
      (await call(h, 'GET', '/calendar/holidays/removals', { bearer: strategy.access })).status,
    ).toBe(403);
    const readOnly = {
      accountId: '',
      roles: [],
      permissions: new Set(['config.read'] as const),
      scopes: [],
    };
    await expect(
      h.app
        .get(HolidayRemovalService)
        .request(actorFor(randomUUID()), readOnly, { holidayId, reason: 'آزمون' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('the database holds two people, keeps a decided request and refuses deletes', async () => {
    const holidayId = await addHoliday(day(1441, 3, 17));
    const asked = await ask(admin, holidayId);
    const id = asked.body['id'] as string;
    await expect(
      app.query(
        `UPDATE holiday_removals SET status = 'rejected', decided_by = requested_by,
         decided_at = now() WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query(`UPDATE holiday_removals SET reason = 'دیگر' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query('DELETE FROM holiday_removals WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await decide(admin2, id, 'reject');
    await expect(
      app.query(`UPDATE holiday_removals SET status = 'approved' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
