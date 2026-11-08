import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { BORROWER_SMS_HOLD, type BorrowerSmsHold } from '../../src/common/repayment/borrower-sms-hold.port';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Row } from '../credit/world';

/**
 * Task 6-6 (doc 15 §4; doc 16; owner 1405/07/15): reminders 3 and 0 days before, overdue
 * notices 1, 7 and 15 days after, by configuration, through the SMS module. Acceptance: no
 * reminder for a paid installment; the job run again makes no second SMS. A held borrower
 * (deceased or disabled, task 6-7) gets none. A slip approved: its SMS, and the paid
 * installment's waiting reminders cancelled; only the messages change.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let finance: Staff;
let steps: ReturnType<typeof fundingSteps>;
let repayment: RepaymentService;
let wallet: WalletService;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  steps = fundingSteps(h, w, { manager, finance });
  repayment = h.app.get(RepaymentService);
  wallet = h.app.get(WalletService);
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** A funded loan of the world: its schedule and first installment. */
async function loan() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const { rows } = await h.owner.query<Row>(
    'SELECT schedule_id FROM funding_requests WHERE purse_id = $1',
    [purseId],
  );
  const scheduleId = rows[0]?.['schedule_id'] as string;
  const first = (await repayment.schedule(scheduleId)).installments[0];
  if (!first) throw new Error('no installment');
  return { patient, purseId, scheduleId, first };
}
type Loan = Awaited<ReturnType<typeof loan>>;

/** Noon in Tehran, `days` from a YYYY-MM-DD day. */
function at(day: string, days: number): Date {
  const d = new Date(`${day}T08:30:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const stepsOf = async (installmentId: string) =>
  (
    await h.owner.query<Row>(
      `SELECT m.kind || ':' || m.offset_days AS step, t.code, d.status
       FROM installment_reminders m
       JOIN sms_dispatches d ON d.id = m.dispatch_id
       JOIN sms_templates t ON t.id = d.template_id
       WHERE m.installment_id = $1 ORDER BY m.created_at, m.id`,
      [installmentId],
    )
  ).rows;

const dispatchesOf = async (installmentId: string) =>
  (
    await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM sms_dispatches
       WHERE starts_with(idempotency_key, $1)`,
      [`repayment:reminder:${installmentId}:`],
    )
  ).rows[0]?.['n'];

/** Staff's slip for an installment in full, approved (task 6-2's path). */
async function pay(l: Loan, amountRial: bigint) {
  const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
    idempotencyKey: `test:receipt:${l.first.id}:${String(amountRial)}`,
    scheduleId: l.scheduleId,
    amountRial,
    receivedAt: new Date(),
    reference: `R-${l.first.id.slice(-8)}`,
  });
  await repayment.approvePayment(CLI_ACTOR, paymentId);
  return paymentId;
}

describe('installment reminders and overdue notices (task 6-6)', () => {
  it('acceptance: a paid installment gets no reminder; the job run again makes no second SMS', async () => {
    const owed = await loan();
    const paid = await loan();
    await pay(paid, paid.first.amountRial);
    const day = owed.first.dueOn;
    expect(paid.first.dueOn).toBe(day);

    await repayment.runReminders(at(day, -3));
    expect(await stepsOf(owed.first.id)).toEqual([
      { step: 'before_due:3', code: 'repayment.reminder_before_due', status: 'scheduled' },
    ]);
    expect(await stepsOf(paid.first.id)).toEqual([]);
    expect(await dispatchesOf(paid.first.id)).toBe(0);

    // Again, the same day: nothing new.
    await repayment.runReminders(at(day, -3));
    expect(await stepsOf(owed.first.id)).toHaveLength(1);
    expect(await dispatchesOf(owed.first.id)).toBe(1);
  });

  it('the steps: 3 and 0 days before, 1, 7 and 15 after; nothing between; Persian digits in the text', async () => {
    const l = await loan();
    const day = l.first.dueOn;
    for (const d of [-3, -2, -1, 0, 1, 2, 6, 7, 8, 14, 15, 16, 30]) {
      await repayment.runReminders(at(day, d));
    }
    expect((await stepsOf(l.first.id)).map((r) => [r['step'], r['code']])).toEqual([
      ['before_due:3', 'repayment.reminder_before_due'],
      ['before_due:0', 'repayment.reminder_due_today'],
      ['overdue:1', 'repayment.overdue_notice'],
      ['overdue:7', 'repayment.overdue_notice'],
      ['overdue:15', 'repayment.overdue_notice'],
    ]);
    const { rows } = await h.owner.query<Row>(
      `SELECT text, audience, mobile FROM sms_dispatches
       WHERE idempotency_key = $1`,
      [`repayment:reminder:${l.first.id}:overdue:7`],
    );
    expect(rows[0]).toMatchObject({ audience: 'borrower', mobile: l.patient.mobile });
    // Persian digits: installment 1, 7 days overdue; a person with no name a customer.
    expect(rows[0]?.['text']).toMatch(/^مشتری گرامی، قسط ۱ به مبلغ .+ به مدت ۷ روز معوق است.$/);
  });

  it('a held borrower (deceased or disabled) gets nothing, and nothing is recorded; lifted, the step goes', async () => {
    const l = await loan();
    const hold = h.app.get<BorrowerSmsHold>(BORROWER_SMS_HOLD);
    const spy = vi.spyOn(hold, 'isHeld').mockResolvedValue(true);
    try {
      const result = await repayment.runReminders(at(l.first.dueOn, -3));
      expect(result.held).toBeGreaterThanOrEqual(1);
      expect(await stepsOf(l.first.id)).toEqual([]);
      expect(await dispatchesOf(l.first.id)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    await repayment.runReminders(at(l.first.dueOn, -3));
    expect((await stepsOf(l.first.id)).map((r) => r['step'])).toEqual(['before_due:3']);
  });

  it('a slip approved: told once; the paid installment’s waiting reminder cancelled; only the allocation posted', async () => {
    const l = await loan();
    await repayment.runReminders(at(l.first.dueOn, -3));
    expect(await stepsOf(l.first.id)).toMatchObject([{ status: 'scheduled' }]);

    const journals = async () =>
      (await h.owner.query<Row>('SELECT count(*)::int AS n FROM journal_entries')).rows[0]?.['n'] as number;
    const purse = await wallet.summary(l.purseId);
    const before = await journals();
    const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:approved:${l.first.id}`,
      scheduleId: l.scheduleId,
      amountRial: l.first.amountRial,
      receivedAt: new Date(),
      reference: `A-${l.first.id.slice(-8)}`,
    });
    const afterReceipt = await journals();
    const decision = await repayment.approvePayment(CLI_ACTOR, paymentId);
    expect(decision.allocatedRial).toBe(l.first.amountRial);
    // 6-2's own postings only: the receipt, then the allocation; the messages post nothing.
    expect(afterReceipt - before).toBe(1);
    expect((await journals()) - afterReceipt).toBe(1);
    expect((await wallet.summary(l.purseId)).borrowerPersonId).toBe(purse.borrowerPersonId);

    expect(await stepsOf(l.first.id)).toMatchObject([{ step: 'before_due:3', status: 'cancelled' }]);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM sms_dispatches WHERE idempotency_key = $1`,
      [`repayment:receipt:${paymentId}:approved-sms`],
    );
    expect(rows[0]?.['n']).toBe(1);
    // Approved again (a replay): no second SMS.
    await repayment.approvePayment(CLI_ACTOR, paymentId);
    const { rows: again } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM sms_dispatches WHERE idempotency_key = $1`,
      [`repayment:receipt:${paymentId}:approved-sms`],
    );
    expect(again[0]?.['n']).toBe(1);

    // Paid: the due-day reminder never comes.
    await repayment.runReminders(at(l.first.dueOn, 0));
    expect(await stepsOf(l.first.id)).toHaveLength(1);
  });

  it('configuration: a new value takes effect on the next run; an empty list turns a kind off', async () => {
    const l = await loan();
    const set = (key: string, value: unknown) =>
      h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ($1, 'global', $2::jsonb, now(), 'approved', 'آزمون', now())`,
        [key, JSON.stringify(value)],
      );
    try {
      await set('repayment.reminder_days_before', [5]);
      await set('repayment.overdue_notice_days', []);
      await repayment.runReminders(at(l.first.dueOn, -5));
      await repayment.runReminders(at(l.first.dueOn, -3));
      await repayment.runReminders(at(l.first.dueOn, 1));
      expect((await stepsOf(l.first.id)).map((r) => r['step'])).toEqual(['before_due:5']);
    } finally {
      await set('repayment.reminder_days_before', [3, 0]);
      await set('repayment.overdue_notice_days', [1, 7, 15]);
    }
  });
});
