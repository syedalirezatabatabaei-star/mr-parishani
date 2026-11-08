import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { startHarness, type Harness } from '../identity/harness';
import { scheduleVersionsNow } from './rounding-version';

/**
 * Task 6-1 [financial] (doc 15 §3, §9 test 4; ADR-019; owner 1405/07/15: computed state and a
 * view): an installment is due on its Tehran day and overdue after its schedule's grace
 * days, with its days past due; the nightly cycle announces each once. Nothing about an
 * installment, nor any document, changes.
 */

let h: Harness;
let wallet: WalletService;
let repayment: RepaymentService;
let counter = 0;
const key = (label: string) => `cycle-test-${label}-${String(++counter)}-${String(Date.now())}`;
const M = 1_000_000n;

type Row = Record<string, unknown>;

async function setGrace(days: number) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('repayment.grace_days', 'global', $1, now(), 'approved', 'آزمون', now())`,
    [JSON.stringify(days)],
  );
}

async function scheduled(principal: bigint, count: number) {
  const approved = await wallet.approveCredit(CLI_ACTOR, {
    idempotencyKey: key('approve'),
    caseId: randomUUID(),
    borrowerPersonId: randomUUID(),
    amountRial: principal,
    scope: { centerNodeId: randomUUID(), doctorNodeId: randomUUID(), treatmentFieldCode: 'dental' },
  });
  await wallet.charge(CLI_ACTOR, approved.purseId, { idempotencyKey: key('charge') });
  const { scheduleId } = await repayment.createSchedule(CLI_ACTOR, {
    idempotencyKey: key('schedule'),
    purseId: approved.purseId,
    installmentCount: count,
    planFeeRial: 0n,
    ...(await scheduleVersionsNow(h)),
  });
  return scheduleId;
}

async function pay(scheduleId: string, amount: bigint) {
  const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
    idempotencyKey: key('receipt'),
    scheduleId,
    amountRial: amount,
    receivedAt: new Date(),
    reference: `slip-${String(counter)}`,
  });
  await repayment.approvePayment(CLI_ACTOR, paymentId);
}

/** HH:MM Tehran (UTC+03:30) on the Gregorian day `day`, `plus` days later. */
function tehran(day: string, hh: number, mm: number, plus = 0): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + plus, hh, mm) - 3.5 * 3_600_000);
}

async function events(installmentId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT event_type, payload FROM outbox_events
     WHERE aggregate_type = 'installment' AND aggregate_id = $1 ORDER BY created_at, id`,
    [installmentId],
  );
  return rows.map((r) => [r['event_type'], (r['payload'] as Row)['daysPastDue'] ?? null]);
}

const journals = async () =>
  (await h.owner.query<Row>('SELECT count(*)::int AS n FROM journal_entries')).rows[0]?.['n'];

beforeAll(async () => {
  h = await startHarness();
  wallet = h.app.get(WalletService);
  repayment = h.app.get(RepaymentService);
});

afterAll(async () => {
  await h.close();
});

describe('the installment cycle (task 6-1)', () => {
  it('doc 15 test 4: due at 23:59 Tehran, overdue at 00:01 the next day; announced once; nothing posted', async () => {
    const scheduleId = await scheduled(12n * M, 3);
    const first = (await repayment.schedule(scheduleId)).installments[0];
    const day = first?.dueOn ?? '';
    const id = first?.id ?? '';
    const before = await journals();

    const late = tehran(day, 23, 59);
    const state = async (at: Date) => {
      const s = await repayment.schedule(scheduleId, at);
      return [s.installments[0]?.status, s.installments[0]?.daysPastDue, s.maxDaysPastDue];
    };
    expect(await state(tehran(day, 23, 59, -1))).toEqual(['scheduled', 0, 0]);
    expect(await state(late)).toEqual(['due', 0, 0]);
    await repayment.runCycle(late);
    expect(await events(id)).toEqual([['installment.due', null]]);

    const after = tehran(day, 0, 1, 1);
    expect(await state(after)).toEqual(['overdue', 1, 1]);
    await repayment.runCycle(after);
    // Run again, and on later nights: no second event.
    await repayment.runCycle(after);
    await repayment.runCycle(tehran(day, 0, 5, 3));
    expect(await events(id)).toEqual([
      ['installment.due', null],
      ['installment.overdue', 1],
    ]);
    expect(await state(tehran(day, 12, 0, 10))).toEqual(['overdue', 10, 10]);
    expect(await journals()).toBe(before);
  });

  it('grace days, locked on the schedule made under them; the earlier schedule keeps its own', async () => {
    const earlier = await scheduled(6n * M, 2);
    await setGrace(2);
    let later: string;
    try {
      later = await scheduled(6n * M, 2);
    } finally {
      await setGrace(0);
    }
    const s = await repayment.schedule(later);
    expect(s.graceDays).toBe(2);
    expect((await repayment.schedule(earlier)).graceDays).toBe(0);
    const day = s.installments[0]?.dueOn ?? '';
    const at = async (plus: number) => {
      const v = await repayment.schedule(later, tehran(day, 10, 0, plus));
      return [v.installments[0]?.status, v.installments[0]?.daysPastDue];
    };
    expect(await at(1)).toEqual(['due', 1]);
    expect(await at(2)).toEqual(['due', 2]);
    expect(await at(3)).toEqual(['overdue', 3]);
    const id = s.installments[0]?.id ?? '';
    await repayment.runCycle(tehran(day, 0, 5, 2));
    expect((await events(id)).filter((e) => e[0] === 'installment.overdue')).toEqual([]);
    await repayment.runCycle(tehran(day, 0, 5, 3));
    expect((await events(id)).filter((e) => e[0] === 'installment.overdue')).toEqual([
      ['installment.overdue', 3],
    ]);
    // The earlier one, without grace, is overdue the day after.
    const e = (await repayment.schedule(earlier, tehran(day, 10, 0, 1))).installments[0];
    expect(e?.status).toBe('overdue');
  });

  it('partly paid, paid, and taken to zero: their states; a paid one is never announced overdue', async () => {
    const scheduleId = await scheduled(9n * M, 3);
    const s = await repayment.schedule(scheduleId);
    const day = s.installments[0]?.dueOn ?? '';
    const first = s.installments[0]?.amountRial ?? 0n;
    await pay(scheduleId, first / 2n);
    expect(
      (await repayment.schedule(scheduleId, tehran(day, 10, 0, -1))).installments[0]?.status,
    ).toBe('partially_paid');
    await pay(scheduleId, first - first / 2n);
    const paid = (await repayment.schedule(scheduleId, tehran(day, 10, 0, 5))).installments[0];
    expect(paid).toMatchObject({ status: 'paid', daysPastDue: 0 });
    await repayment.runCycle(tehran(day, 0, 5, 5));
    expect(await events(paid?.id ?? '')).toEqual([]);

    // The last taken to zero by a revision (4-8): cancelled, never overdue.
    const last = s.installments.at(-1);
    await repayment.reduceFromLast(CLI_ACTOR, {
      scheduleId,
      amountRial: last?.amountRial ?? 0n,
      idempotencyKey: key('reduce'),
      reason: 'لغو بخشی',
    });
    const far = tehran(last?.dueOn ?? '', 10, 0, 30);
    expect((await repayment.schedule(scheduleId, far)).installments.at(-1)).toMatchObject({
      status: 'cancelled',
      daysPastDue: 0,
    });
  });

  it('the view agrees with the service for every installment, as of today in Tehran', async () => {
    const ids = [await scheduled(12n * M, 4), await scheduled(5n * M, 2)];
    await pay(ids[0] ?? '', 4n * M);
    await repayment.runCycle(new Date());
    for (const scheduleId of ids) {
      const s = await repayment.schedule(scheduleId, new Date());
      const { rows } = await h.owner.query<Row>(
        `SELECT installment_id, status, days_past_due, outstanding_rial::text AS outstanding
         FROM installment_states WHERE schedule_id = $1`,
        [scheduleId],
      );
      const byId = new Map(rows.map((r) => [r['installment_id'], r]));
      for (const i of s.installments) {
        expect(byId.get(i.id)).toMatchObject({
          status: i.status,
          days_past_due: i.daysPastDue,
          outstanding: i.outstandingRial.toString(),
        });
      }
    }
    const { rows } = await h.owner.query<Row>('SELECT max_days_past_due FROM case_overdue LIMIT 1');
    expect(rows.length).toBe(1);
  });
});
