import { randomUUID } from 'node:crypto';
import { addJalaliMonths, gregorianDayOf, nominalDueOn, toJalali } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '../../src/modules/config/config.service';
import { DATABASE, type Database } from '../../src/db/database.module';
import { HolidayService } from '../../src/modules/config/holiday.service';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { actorFor, newIp, startHarness, type Harness } from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Patient } from '../credit/world';

/**
 * «Moved from [the nominal day] because of a holiday» in the borrower's own schedule (owner
 * 1405/07/24): read only. Every amount and due day the borrower reads is the stored one; the
 * nominal day comes from the stored funding time, beside a due day moved at funding only.
 * Another patient reads nothing of it (rule 13).
 */

type Row = Record<string, unknown>;
type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let steps: ReturnType<typeof fundingSteps>;

const manage = (permission: 'config.manage_business' | 'config.manage_holidays') => ({
  accountId: '',
  roles: [],
  permissions: new Set([permission] as const),
  scopes: [],
});

/** Two people, as the key is sensitive. Locked on a case when it is created (ADR-041). */
async function shift(on: boolean) {
  const config = h.app.get(ConfigService);
  const proposal = await config.propose(actorFor(randomUUID()), manage('config.manage_business'), {
    key: 'repayment.shift_due_to_next_working_day',
    scope: { level: 'global' },
    value: on,
    reason: 'آزمون سررسید جابه‌جاشده',
  });
  await config.decide(actorFor(randomUUID()), manage('config.manage_business'), proposal.id, true);
}

const mine = (p: Patient, applicationId: string) =>
  fetch(`${h.baseUrl}/me/repayment/schedules?creditApplicationId=${applicationId}`, {
    headers: { authorization: `Bearer ${p.token}`, 'x-forwarded-for': newIp() },
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Body[] }));

async function loan() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const purse = await h.app.get(WalletService).summary(purseId);
  const [scheduleId] = await h.app.get(RepaymentService).schedulesOf(purse.caseId);
  return { patient, applicationId, scheduleId: scheduleId ?? '' };
}

const stored = async (scheduleId: string) =>
  (
    await h.owner.query<Row>(
      `SELECT i.index, to_char(i.due_on, 'YYYY-MM-DD') AS due_on, i.amount_rial::text AS amount,
              s.funded_at, s.due_dates_shifted
       FROM installments i JOIN installment_schedules s ON s.id = i.schedule_id
       WHERE i.schedule_id = $1 ORDER BY i.index`,
      [scheduleId],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  steps = fundingSteps(h, w, {
    manager: await w.role('credit_manager'),
    finance: await w.role('accounting'),
  });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('a due day moved at funding, as the borrower reads it (owner 1405/07/24)', () => {
  it('says where it came from; every amount and due day read is the stored one; another patient reads nothing', async () => {
    // Holidays on the nominal due days of installments 1 and 2 of a loan funded today.
    const today = toJalali(new Date());
    // Fixtures through the one service path left (owner 1405/07/27: a batch's approval adds).
    const holidays = h.app.get(HolidayService);
    const db = h.app.get<Database>(DATABASE);
    for (const k of [1, 2]) {
      await db.transaction((tx) =>
        holidays.addInTransaction(tx, actorFor(randomUUID()), {
          on: addJalaliMonths(today, k),
          title: 'تعطیلی آزمون',
          reason: 'آزمون سررسید جابه‌جاشده',
        }),
      );
    }

    // Shift on for this case: its due days move.
    await shift(true);
    const moved = await loan();
    await shift(false);
    // Shift off for this one: holidays or not, nothing moves.
    const plain = await loan();

    const rows = await stored(moved.scheduleId);
    expect(rows[0]?.['due_dates_shifted']).toBe(true);
    const fundedAt = new Date(rows[0]?.['funded_at'] as string);
    const read = await mine(moved.patient, moved.applicationId);
    expect(read.status).toBe(200);
    const installments = read.body[0]?.['installments'] as Body[];
    expect(installments).toHaveLength(rows.length);
    installments.forEach((i, n) => {
      const row = rows[n];
      // Exactly what is stored: the due day and the amount.
      expect(i).toMatchObject({
        index: row?.['index'],
        dueOn: row?.['due_on'],
        amountRial: row?.['amount'],
      });
      const nominal = nominalDueOn(fundedAt, Number(row?.['index']));
      expect(i['movedFrom']).toBe(nominal === row?.['due_on'] ? null : nominal);
    });
    // Both holidays moved their installment; the note names the nominal day.
    for (const k of [1, 2]) {
      expect(installments[k - 1]?.['movedFrom']).toBe(gregorianDayOf(addJalaliMonths(today, k)));
      expect(installments[k - 1]?.['dueOn']).not.toBe(installments[k - 1]?.['movedFrom']);
    }

    // Not moved: no note, though its nominal days are holidays too.
    const plainRows = await stored(plain.scheduleId);
    expect(plainRows[0]?.['due_dates_shifted']).toBe(false);
    const plainRead = await mine(plain.patient, plain.applicationId);
    const plainInstallments = plainRead.body[0]?.['installments'] as Body[];
    expect(plainInstallments.map((i) => [i['dueOn'], i['amountRial'], i['movedFrom']])).toEqual(
      plainRows.map((r) => [r['due_on'], r['amount'], null]),
    );

    // Another patient: nothing of it (rule 13), not the note either.
    const other = await w.patient();
    expect(await mine(other, moved.applicationId)).toEqual({ status: 200, body: [] });
    // Staff do not use the self-service route.
    const staff = await w.staff(
      w.completion,
      'GET',
      `/me/repayment/schedules?creditApplicationId=${moved.applicationId}`,
    );
    expect(staff.status).toBe(403);

    // Read only: the stored schedule is as it was.
    expect(await stored(moved.scheduleId)).toEqual(rows);
  });
});
