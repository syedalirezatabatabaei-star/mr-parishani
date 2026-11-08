import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { gregorianDayOf, toJalali } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { LEDGER, type LedgerPort } from '../../src/common/ledger/ledger.port';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { payoutKey } from '../../src/modules/settlement/payout.service';
import { SettlementReconciliation } from '../../src/modules/settlement/settlement-reconciliation';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { StatementService } from '../../src/modules/settlement/statement.service';
import { WorkerModule } from '../../src/worker.module';
import { sheba } from '../catalog/fixtures';
import {
  CapturingTextSender,
  startHarness,
  type Harness,
  type loggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 5-5 [financial] (doc 06 §5 steps 3–6, §8 test 6; doc 14 ث; doc 02 §4; owner
 * 1405/07/14): a statement reviewed by one and approved by another; one payout order per
 * center, to its Sheba as it was then; paid only once the bank's tracking number is recorded
 * by one and confirmed by another: Dr doctor.payable / Cr bank.settlement.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let manager: Staff;
let finance: Staff;
let finance2: Staff;
let finance3: Staff;
let advisor: Staff;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  const first = await creditWorld(h);
  manager = await first.role('credit_manager');
  finance = await first.role('accounting');
  finance2 = await first.role('accounting');
  finance3 = await first.role('accounting');
  advisor = await first.role('advisor');
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const settlement = () => h.app.get(SettlementService);
const statements = () => h.app.get(StatementService);
const ledger = () => h.app.get<LedgerPort>(LEDGER);

async function setRate(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}
const ZERO = { basis: 'percent', bps: 0 };

async function doctor() {
  const w = await creditWorld(h);
  return { w, steps: fundingSteps(h, w, { manager, finance }) };
}

const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

interface Item {
  payableId: string;
  feeId: string;
  amount: bigint;
  fee: bigint;
  doctorId: string;
  doctorNodeId: string;
  centerId: string;
  dueAt: Date;
}

/** A funded purse, one service final, its payable and fee made and due. */
async function service(d: Awaited<ReturnType<typeof doctor>>): Promise<Item> {
  const { patient, applicationId } = await d.steps.approved();
  await d.steps.complete(patient, applicationId);
  const purseId = await d.steps.fund(applicationId);
  const lines = (await d.w.staff(d.w.doctor, 'GET', `/service/patients/${purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await d.w.staff(d.w.doctor, 'POST', '/service/authorizations', {
    purseId,
    proformaLineIds: [lines[0]?.['id']],
  });
  const done = await d.w.staff(
    d.w.doctor,
    'POST',
    `/service/authorizations/${made.body['id'] as string}/deliver`,
    { code: lastCode(patient.mobile) },
  );
  expect(done.body['status']).toBe('finalized');
  const { payableId } = await settlement().accrue(CLI_ACTOR, made.body['id'] as string);
  const { rows } = await h.owner.query<Row>(
    `SELECT p.doctor_id, p.doctor_node_id, p.center_id, p.amount_rial::text AS amount, p.due_at,
            f.id AS fee_id, f.amount_rial::text AS fee
     FROM doctor_payables p JOIN service_fees f ON f.doctor_payable_id = p.id WHERE p.id = $1`,
    [payableId],
  );
  const r = rows[0] as Row;
  const dueAt = r['due_at'] as Date;
  await settlement().markDue(dueAt);
  return {
    payableId,
    feeId: r['fee_id'] as string,
    amount: BigInt(r['amount'] as string),
    fee: BigInt(r['fee'] as string),
    doctorId: r['doctor_id'] as string,
    doctorNodeId: r['doctor_node_id'] as string,
    centerId: r['center_id'] as string,
    dueAt,
  };
}

const monthOf = (at: Date) => {
  const j = toJalali(at);
  return { year: j.year, month: j.month };
};
const next = (p: { year: number; month: number }) =>
  p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 };

/** A service with a 10% fee, and its month's statement drafted. */
async function drafted(d: Awaited<ReturnType<typeof doctor>>) {
  await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 1000 });
  let a: Item;
  try {
    a = await service(d);
  } finally {
    await setRate('settlement.credit_service_fee', ZERO);
  }
  const made = await statements().generateFor(
    CLI_ACTOR,
    a.doctorId,
    monthOf(a.dueAt).year,
    monthOf(a.dueAt).month,
  );
  return { a, statementId: made?.statementId as string };
}

const step = (w: World, who: Staff, path: string, body?: unknown) =>
  w.staff(who, 'POST', path, body);
const review = (w: World, who: Staff, id: string) =>
  step(w, who, `/settlement/statements/${id}/review`);
const approve = (w: World, who: Staff, id: string) =>
  step(w, who, `/settlement/statements/${id}/approve`);
const ordersOf = async (w: World, statementId: string) =>
  (await w.staff(finance, 'GET', `/settlement/payouts?statementId=${statementId}`))
    .body as unknown as Body[];
const exportAll = (w: World, who: Staff, payoutIds?: string[]) =>
  step(w, who, '/settlement/payouts/export', payoutIds ? { payoutIds } : {});
const today = () => gregorianDayOf(toJalali(new Date()));
const tracking = (w: World, who: Staff, id: string, ref: string) =>
  step(w, who, `/settlement/payouts/${id}/tracking`, { bankTrackingRef: ref, paidOn: today() });
const confirm = (w: World, who: Staff, id: string) =>
  step(w, who, `/settlement/payouts/${id}/confirm`);
let refs = 0;
const ref = () => `TRK-${String(Date.now())}-${String((refs += 1))}`;

async function balanceOf(code: 'doctor.payable' | 'doctor.fee_receivable', node: string) {
  const account = await ledger().findAccount({
    entityId: 'aramesh',
    code,
    ownerType: 'doctor',
    ownerId: node,
  });
  if (!account) return 0n;
  const b = await ledger().balanceOf(account.id);
  return code === 'doctor.payable' ? b.creditRial - b.debitRial : b.debitRial - b.creditRial;
}

async function statusOf(statementId: string) {
  const { rows } = await h.owner.query<Row>(
    'SELECT status FROM settlement_statements WHERE id = $1',
    [statementId],
  );
  return rows[0]?.['status'];
}

async function sound() {
  const { rows } = await h.owner.query<Row>(
    `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
     HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
  );
  expect(rows).toEqual([]);
  const ctx = worker as INestApplicationContext;
  expect(await ctx.get(LedgerReconciliation).run()).toMatchObject({ clean: true });
  expect(await ctx.get(SettlementReconciliation).run()).toMatchObject({ clean: true });
}

describe('review, approval and payout orders (task 5-5)', () => {
  it('the whole way: one order to the center, paid on a confirmed tracking number; ledger and items closed', async () => {
    const d = await doctor();
    const { a, statementId } = await drafted(d);
    const payable = a.amount - a.fee;

    expect((await review(d.w, finance, statementId)).body).toMatchObject({
      status: 'reviewed',
      reviewedByMe: true,
    });
    const approved = await approve(d.w, finance2, statementId);
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const orders = await ordersOf(d.w, statementId);
    expect(orders).toHaveLength(1);
    const order = orders[0] as Body;
    expect(order).toMatchObject({
      centerId: a.centerId,
      amountRial: payable.toString(),
      status: 'issued',
    });
    // Approving twice issues nothing more.
    await approve(d.w, finance3, statementId);
    expect(await ordersOf(d.w, statementId)).toHaveLength(1);

    // The bank file: the Sheba in full only there.
    const account = await d.w.staff(finance, 'GET', `/catalog/centers/${a.centerId}/bank-account`);
    const file = await exportAll(d.w, finance, [order['id'] as string]);
    expect(file.status).toBe(201);
    expect(file.body).toMatchObject({ count: 1, totalRial: payable.toString() });
    const csv = file.body['csv'] as string;
    expect(csv).toContain(account.body['sheba'] as string);
    expect(csv).toContain(`,${payable.toString()},`);
    expect(JSON.stringify(order)).not.toContain(account.body['sheba'] as string);
    // The same file again, nothing moved.
    const again = await d.w.staff(
      finance,
      'GET',
      `/settlement/payouts/exports/${file.body['batchId'] as string}`,
    );
    expect(again.body['csv']).toBe(csv);
    const { rows: audited } = await h.owner.query<Row>(
      `SELECT after::text AS after FROM audit_events WHERE action LIKE 'settlement.payouts_export%'`,
    );
    for (const r of audited) expect(r['after']).not.toContain(account.body['sheba'] as string);

    const payableBefore = await balanceOf('doctor.payable', a.doctorNodeId);
    expect(payableBefore).toBe(payable);
    const id = order['id'] as string;
    expect((await tracking(d.w, finance, id, ref())).body).toMatchObject({
      status: 'sent_to_bank',
      trackingRecordedByMe: true,
    });
    const paid = await confirm(d.w, finance2, id);
    expect(paid.body).toMatchObject({ status: 'confirmed' });
    const journal = paid.body['journalEntryId'] as string;
    const { rows: entries } = await h.owner.query<Row>(
      `SELECT a.code, e.direction, e.amount_rial::text AS amount
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       WHERE e.journal_entry_id = $1 ORDER BY a.code`,
      [journal],
    );
    expect(entries).toEqual([
      { code: 'bank.settlement', direction: 'credit', amount: payable.toString() },
      { code: 'doctor.payable', direction: 'debit', amount: payable.toString() },
    ]);
    const { rows: keyed } = await h.owner.query<Row>(
      'SELECT id FROM journal_entries WHERE idempotency_key = $1',
      [payoutKey(id)],
    );
    expect(keyed.map((r) => r['id'])).toEqual([journal]);
    expect(await balanceOf('doctor.payable', a.doctorNodeId)).toBe(0n);
    expect(await statusOf(statementId)).toBe('paid');
    const { rows: items } = await h.owner.query<Row>(
      `SELECT p.status AS payable, f.status AS fee FROM doctor_payables p
       JOIN service_fees f ON f.doctor_payable_id = p.id WHERE p.id = $1`,
      [a.payableId],
    );
    expect(items[0]).toEqual({ payable: 'paid', fee: 'settled' });
    // Confirmed again: nothing more.
    expect((await confirm(d.w, finance3, id)).body['journalEntryId']).toBe(journal);
    await sound();
  });

  it('doc 06 test 6: one person alone never reviews and approves, nor records and confirms', async () => {
    const d = await doctor();
    const { statementId } = await drafted(d);
    expect((await review(d.w, advisor, statementId)).status).toBe(403);
    await review(d.w, finance, statementId);
    const alone = await approve(d.w, finance, statementId);
    expect(alone.status).toBe(409);
    expect(alone.body['error']).toBe('same_person');
    expect(await statusOf(statementId)).toBe('reviewed');
    await approve(d.w, finance2, statementId);
    const [order] = await ordersOf(d.w, statementId);
    const id = (order as Body)['id'] as string;

    // No tracking number confirmed: never paid, nothing posted.
    expect((await confirm(d.w, finance2, id)).body['error']).toBe('payout_not_sent');
    expect((await exportAll(d.w, advisor, [id])).status).toBe(403);
    await exportAll(d.w, finance, [id]);
    expect((await confirm(d.w, finance2, id)).body['error']).toBe('tracking_missing');
    await tracking(d.w, finance, id, ref());
    const self = await confirm(d.w, finance, id);
    expect(self.status).toBe(409);
    expect(self.body['error']).toBe('same_person');
    expect(await statusOf(statementId)).toBe('approved');
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1',
      [payoutKey(id)],
    );
    expect(rows[0]?.['n']).toBe(0);
    // The database refuses it too.
    await expect(
      h.owner.query(`UPDATE payout_orders SET confirmed_by = tracking_recorded_by WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/payout_orders_two_people_check/);
    await sound();
  });

  it('owner س3: nothing to pay — paid at once, no order; the rest carried to the next month', async () => {
    const d = await doctor();
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 10_000 });
    let a: Item;
    try {
      a = await service(d);
    } finally {
      await setRate('settlement.credit_service_fee', ZERO);
    }
    const p = monthOf(a.dueAt);
    const s = await statements().generateFor(CLI_ACTOR, a.doctorId, p.year, p.month);
    const id = s?.statementId as string;
    await review(d.w, finance, id);
    expect((await approve(d.w, finance2, id)).body).toMatchObject({
      status: 'paid',
      payableRial: '0',
    });
    expect(await ordersOf(d.w, id)).toEqual([]);
    expect(await balanceOf('doctor.payable', a.doctorNodeId)).toBe(0n);
    await sound();
  });

  it('owner س2 and doc 06 test 4: an item disputed after the draft stops its review; one of an approved statement cannot be disputed', async () => {
    const d = await doctor();
    const { a, statementId } = await drafted(d);
    const open = (subjectId: string) =>
      d.w.staff(finance3, 'POST', '/settlement/disputes', {
        subjectType: 'doctor_payable',
        subjectId,
        reason: 'پزشک به این قلم اعتراض دارد',
      });
    const opened = await open(a.payableId);
    expect(opened.status).toBe(201);
    const changed = await review(d.w, finance, statementId);
    expect(changed.status).toBe(409);
    expect(changed.body['error']).toBe('statement_items_changed');
    // Cancelled by two, made again once the dispute is rejected, then approved.
    await d.w.staff(
      finance2,
      'POST',
      `/settlement/disputes/${opened.body['id'] as string}/resolve`,
      {
        outcome: 'rejected',
        note: 'بررسی شد',
      },
    );
    for (const who of [finance, finance2]) {
      await step(d.w, who, `/settlement/statements/${statementId}/cancel`, {
        reason: 'ساخت دوباره',
      });
    }
    const p = monthOf(a.dueAt);
    const again = (await statements().generateFor(CLI_ACTOR, a.doctorId, p.year, p.month))
      ?.statementId as string;
    await review(d.w, finance, again);
    await approve(d.w, finance2, again);
    const late = await open(a.payableId);
    expect(late.status).toBe(409);
    expect(late.body['error']).toBe('statement_approved');
    await sound();
  });

  it('the Sheba is a snapshot: changed after issue, the order keeps it; failed by two and reissued, the new one takes the new Sheba', async () => {
    const d = await doctor();
    const { a, statementId } = await drafted(d);
    await review(d.w, finance, statementId);
    await approve(d.w, finance2, statementId);
    const [first] = await ordersOf(d.w, statementId);
    const id = (first as Body)['id'] as string;

    // The center's bank account changed by two people (task 2-2).
    const fresh = sheba();
    const proposed = await d.w.staff(
      d.w.specialist,
      'POST',
      `/catalog/centers/${a.centerId}/bank-account-requests`,
      { sheba: fresh, accountHolderName: 'صاحب تازه', reason: 'حساب تازه' },
    );
    expect(proposed.status).toBe(201);
    expect(
      (
        await d.w.staff(
          finance,
          'POST',
          `/catalog/requests/${proposed.body['id'] as string}/approve`,
          {},
        )
      ).status,
    ).toBe(200);

    const file = await exportAll(d.w, finance, [id]);
    expect(file.body['csv'] as string).not.toContain(fresh);
    // Failed: asked by one, done by another; nothing posted.
    const asked = await step(d.w, finance, `/settlement/payouts/${id}/fail`, {
      reason: 'بانک برگرداند',
    });
    expect(asked.body).toMatchObject({ status: 'sent_to_bank', failRequestedByMe: true });
    expect(
      (await step(d.w, finance, `/settlement/payouts/${id}/fail`, { reason: 'دوباره' })).body,
    ).toMatchObject({ status: 'sent_to_bank' });
    expect(
      (await step(d.w, finance2, `/settlement/payouts/${id}/fail`, { reason: 'بانک برگرداند' }))
        .body,
    ).toMatchObject({ status: 'failed' });
    expect((await tracking(d.w, finance, id, ref())).body['error']).toBe('payout_not_sent');

    const reissued = await step(d.w, finance, `/settlement/payouts/${id}/reissue`);
    expect(reissued.body).toMatchObject({
      status: 'issued',
      replacesPayoutId: id,
      amountRial: (first as Body)['amountRial'],
      ibanLast4: fresh.slice(-4),
    });
    const second = reissued.body['id'] as string;
    // Reissued again: the same one.
    expect((await step(d.w, finance2, `/settlement/payouts/${id}/reissue`)).body['id']).toBe(
      second,
    );
    const file2 = await exportAll(d.w, finance, [second]);
    expect(file2.body['csv'] as string).toContain(fresh);
    await tracking(d.w, finance, second, ref());
    await confirm(d.w, finance2, second);
    expect(await statusOf(statementId)).toBe('paid');
    await sound();
  });

  it('confirmed at the same time by two: one document; a tracking number is used once; a suspended center is still paid', async () => {
    const d = await doctor();
    const one = await drafted(d);
    await review(d.w, finance, one.statementId);
    // doc 08 §3: suspended after the statement was made; settlement goes on.
    const suspended = await d.w.staff(
      d.w.specialist,
      'POST',
      `/catalog/centers/${one.a.centerId}/suspend`,
      { reason: 'تعلیق آزمون' },
    );
    expect(suspended.body['status']).toBe('suspended');
    await approve(d.w, finance2, one.statementId);
    const [order] = await ordersOf(d.w, one.statementId);
    const id = (order as Body)['id'] as string;
    await exportAll(d.w, finance, [id]);
    const used = ref();
    await tracking(d.w, finance, id, used);

    const other = await doctor();
    const two = await drafted(other);
    await review(other.w, finance, two.statementId);
    await approve(other.w, finance2, two.statementId);
    const [order2] = await ordersOf(other.w, two.statementId);
    const id2 = (order2 as Body)['id'] as string;
    await exportAll(other.w, finance, [id2]);
    const dup = await tracking(other.w, finance, id2, used);
    expect(dup.status).toBe(409);
    expect(dup.body['error']).toBe('tracking_ref_used');

    const both = await Promise.all([confirm(d.w, finance2, id), confirm(d.w, finance3, id)]);
    expect(both.map((r) => r.body['status'])).toEqual(['confirmed', 'confirmed']);
    expect(both[0].body['journalEntryId']).toBe(both[1].body['journalEntryId']);
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1',
      [payoutKey(id)],
    );
    expect(rows[0]?.['n']).toBe(1);
    expect(await statusOf(one.statementId)).toBe('paid');
    await sound();
  });

  it('the next month after a paid statement: carried and offset per node stay reconciled', async () => {
    const d = await doctor();
    const { a, statementId } = await drafted(d);
    await review(d.w, finance, statementId);
    await approve(d.w, finance2, statementId);
    const [order] = await ordersOf(d.w, statementId);
    const id = (order as Body)['id'] as string;
    await exportAll(d.w, finance, [id]);
    await tracking(d.w, finance, id, ref());
    await confirm(d.w, finance2, id);
    await setRate('settlement.contract_cycle_months', 2);
    let b: Item;
    try {
      b = await service(d);
    } finally {
      await setRate('settlement.contract_cycle_months', 1);
    }
    const p = next(monthOf(a.dueAt));
    const s2 = await statements().generateFor(CLI_ACTOR, a.doctorId, p.year, p.month);
    expect(
      (await d.w.staff(finance, 'GET', `/settlement/statements/${s2?.statementId as string}`)).body,
    ).toMatchObject({ grossCreditServicesRial: b.amount.toString(), carriedInRial: '0' });
    expect(await balanceOf('doctor.payable', a.doctorNodeId)).toBe(b.amount);
    await sound();
  });
});
