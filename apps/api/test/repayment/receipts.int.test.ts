import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { LEDGER, type LedgerPort } from '../../src/common/ledger/ledger.port';
import { REPAYMENT, type RepaymentPort } from '../../src/common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../src/common/wallet/wallet.port';
import { DownPaymentReconciliation } from '../../src/modules/contract/down-payment-reconciliation';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { WorkerModule } from '../../src/worker.module';
import { newIp, startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, PDF, type Body, type Row } from '../credit/world';
import { scheduleVersionsNow } from './rounding-version';

/**
 * Task 6-2 [financial] (doc 15 §2, §9 tests 1, 2, 3, 13, 14; owner 1405/07/15): the
 * borrower's slip on phase 1's payments. Allocated oldest first, a surplus left in suspense
 * and reported; a slip like one received flagged and approved only on an explicit decision;
 * rejected as never received (its pending posting reversed) or received but not accepted
 * (left in suspense), with an SMS; a schedule paid in full settled once, its case completed
 * when all of its schedules are. No penalty, no discount.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let finance: Staff;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  steps = fundingSteps(h, w, { manager, finance });
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const repayment = () => h.app.get<RepaymentPort>(REPAYMENT);
const wallet = () => h.app.get<WalletPort>(WALLET);
const ledger = () => h.app.get<LedgerPort>(LEDGER);

/** A funded loan of the world: its borrower, schedule and case. */
async function loan() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const { rows } = await h.owner.query<Row>(
    'SELECT schedule_id FROM funding_requests WHERE purse_id = $1',
    [purseId],
  );
  const scheduleId = rows[0]?.['schedule_id'] as string;
  const purse = await wallet().summary(purseId);
  return { patient, purseId, scheduleId, caseId: purse.caseId };
}
type Loan = Awaited<ReturnType<typeof loan>>;

async function slip(
  l: Pick<Loan, 'patient' | 'scheduleId'>,
  fields: { amountRial: string; bankRef: string; paidOn?: string },
  file: Buffer = PDF,
) {
  const form = new FormData();
  form.append('scheduleId', l.scheduleId);
  form.append('amountRial', fields.amountRial);
  form.append('paidOn', fields.paidOn ?? '2026-10-05');
  form.append('bankRef', fields.bankRef);
  form.append('payerName', 'وام‌گیرنده آزمون');
  form.append('file', new Blob([new Uint8Array(file)]), 'slip.pdf');
  const res = await fetch(`${h.baseUrl}/me/repayment/receipts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${l.patient.token}`,
      'x-forwarded-for': newIp(),
      'idempotency-key': randomUUID(),
    },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const approve = (id: string, body: Body = {}) =>
  w.staff(finance, 'POST', `/repayment/payments/${id}/approve`, body);
const reject = (id: string, kind: string) =>
  w.staff(finance, 'POST', `/repayment/payments/${id}/reject`, { kind, reason: 'بررسی شد' });

async function bankCollection() {
  const account = await ledger().findAccount({
    entityId: 'aramesh',
    code: 'bank.collection',
    ownerType: 'company',
    ownerId: null,
  });
  return account ? (await ledger().balanceOf(account.id)).netDebitRial : 0n;
}

async function sound() {
  const { rows } = await h.owner.query<Row>(
    `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
     HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
  );
  expect(rows).toEqual([]);
  const ctx = worker as INestApplicationContext;
  expect(await ctx.get(LedgerReconciliation).run()).toMatchObject({ clean: true });
  expect(await ctx.get(DownPaymentReconciliation).run()).toMatchObject({ clean: true });
}

describe('payment slips (task 6-2)', () => {
  it('doc 15 test 1: oldest installment first; a surplus stays in suspense and is reported', async () => {
    const l = await loan();
    const s = await repayment().schedule(l.scheduleId);
    const first = s.installments[0]?.amountRial ?? 0n;
    const sent = await slip(l, {
      amountRial: String(first + 1_000n),
      bankRef: `TRK-${randomUUID().slice(0, 8)}`,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body['suspectedDuplicate']).toBe(false);
    const id = sent.body['paymentId'] as string;
    // In the queue, with its image and channel.
    const queue = (await w.staff(finance, 'GET', '/repayment/payments?status=pending_approval'))
      .body as unknown as Body[];
    expect(queue.find((p) => p['id'] === id)).toMatchObject({
      channel: 'manual_receipt',
      hasImage: true,
      suspectedDuplicateOf: null,
    });
    const done = await approve(id);
    expect(done.status).toBe(200);
    // The oldest first, then on to the next: no surplus while anything is owed.
    expect(done.body).toMatchObject({ allocatedRial: String(first + 1_000n), surplusRial: '0' });
    const after = await repayment().schedule(l.scheduleId);
    expect(after.installments[0]).toMatchObject({ status: 'paid', paidRial: first });
    expect(after.installments[1]?.paidRial).toBe(1_000n);
    expect(after.installments[2]?.paidRial).toBe(0n);

    // More than all that is owed: the rest stays in suspense, reported, never moved back.
    const all = await slip(l, {
      amountRial: String(after.outstandingRial + 2_000n),
      bankRef: `TRK-${randomUUID().slice(0, 8)}`,
    });
    const paid = await approve(all.body['paymentId'] as string);
    expect(paid.body).toMatchObject({
      allocatedRial: after.outstandingRial.toString(),
      surplusRial: '2000',
    });
    const suspense = (await w.staff(finance, 'GET', '/repayment/suspense'))
      .body as unknown as Body[];
    expect(suspense.find((r) => r['scheduleId'] === l.scheduleId)).toMatchObject({
      unallocatedRial: '2000',
      surplusRial: '2000',
    });
    await sound();
  });

  it('doc 15 test 2: approved twice, once; a slip like one received is flagged and needs an explicit decision', async () => {
    const l = await loan();
    const ref = `TRK ${String(Date.now()).slice(-6)}`;
    const one = await slip(l, { amountRial: '500000', bankRef: ref });
    const id = one.body['paymentId'] as string;
    expect((await approve(id)).status).toBe(200);
    const again = await approve(id);
    expect(again.body).toMatchObject({ allocatedRial: '500000' });
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = $1',
      [id],
    );
    expect(rows[0]?.['n']).toBe(1);

    // The same reference written another way (Persian digits, no space), same amount and day.
    const persian = ref.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d).replace(' ', '-');
    const twin = await slip(l, { amountRial: '500000', bankRef: persian });
    expect(twin.status).toBe(201);
    expect(twin.body['suspectedDuplicate']).toBe(true);
    const twinId = twin.body['paymentId'] as string;
    const blocked = await approve(twinId);
    expect(blocked.status).toBe(409);
    expect(blocked.body['error']).toBe('suspected_duplicate');
    expect((await approve(twinId, { notDuplicate: true })).status).toBe(409);
    // The flag posts nothing: only the pending receipt, like any slip.
    const { rows: docs } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key LIKE $1`,
      [`repayment:%${twinId}%`],
    );
    expect(docs[0]?.['n']).toBe(0);
    // It was the same money: rejected as never received, its pending posting reversed.
    const before = await bankCollection();
    expect((await reject(twinId, 'not_received')).status).toBe(200);
    expect(await bankCollection()).toBe(before - 500_000n);
    // A different slip that only looks the same is approved with a reason.
    const third = await slip(l, { amountRial: '500000', bankRef: ref });
    expect(third.body['suspectedDuplicate']).toBe(true);
    const cleared = await approve(third.body['paymentId'] as string, {
      notDuplicate: true,
      reason: 'دو واریز جدا، تأیید بانک',
    });
    expect(cleared.status).toBe(200);
    await sound();
  });

  it('two kinds of rejection: never received is reversed exactly; received stays in suspense; an SMS either way', async () => {
    const l = await loan();
    const before = await bankCollection();
    const fake = await slip(l, {
      amountRial: '700000',
      bankRef: `TRK-${randomUUID().slice(0, 8)}`,
    });
    expect(await bankCollection()).toBe(before + 700_000n);
    const fakeId = fake.body['paymentId'] as string;
    expect((await reject(fakeId, 'not_received')).body).toMatchObject({ status: 'rejected' });
    expect(await bankCollection()).toBe(before);
    const { rows: rev } = await h.owner.query<Row>(
      'SELECT reject_kind, reject_journal_entry_id FROM payments WHERE id = $1',
      [fakeId],
    );
    expect(rev[0]?.['reject_kind']).toBe('not_received');
    expect(rev[0]?.['reject_journal_entry_id']).not.toBeNull();

    const kept = await slip(l, {
      amountRial: '300000',
      bankRef: `TRK-${randomUUID().slice(0, 8)}`,
    });
    const keptId = kept.body['paymentId'] as string;
    await reject(keptId, 'received_unaccepted');
    expect(await bankCollection()).toBe(before + 300_000n);
    const suspense = (await w.staff(finance, 'GET', '/repayment/suspense'))
      .body as unknown as Body[];
    expect(suspense.find((r) => r['scheduleId'] === l.scheduleId)).toMatchObject({
      unallocatedRial: '300000',
      rejectedReceivedRial: '300000',
    });
    // The borrower is told, twice, by the notification module.
    const { rows: sms } = await h.owner.query<Row>(
      `SELECT d.idempotency_key FROM sms_dispatches d JOIN sms_templates t ON t.id = d.template_id
       WHERE t.code = 'repayment.receipt_rejected' AND d.idempotency_key IN ($1, $2)`,
      [`repayment:receipt:${fakeId}:rejected-sms`, `repayment:receipt:${keptId}:rejected-sms`],
    );
    expect(sms).toHaveLength(2);
    await sound();
  });

  it('doc 15 test 3: no penalty and no discount, by any path or field', async () => {
    const l = await loan();
    const before = await repayment().schedule(l.scheduleId);
    // Long overdue: the amounts never move.
    const late = await repayment().schedule(l.scheduleId, new Date(Date.now() + 400 * 86_400_000));
    expect(late.installments.map((i) => i.amountRial)).toEqual(
      before.installments.map((i) => i.amountRial),
    );
    expect(late.totalRial).toBe(before.totalRial);
    // A field that would change an amount is refused, not ignored.
    const sent = await slip(l, {
      amountRial: '100000',
      bankRef: `TRK-${randomUUID().slice(0, 8)}`,
    });
    const tried = await w.staff(
      finance,
      'POST',
      `/repayment/payments/${sent.body['paymentId'] as string}/approve`,
      {
        discountRial: '50000',
      },
    );
    expect(tried.status).toBe(400);
  });

  it('owner condition: never completed early — one of two schedules settled leaves the case exactly as it was', async () => {
    const l = await loan();
    const purse = await wallet().summary(l.purseId);
    const second = await wallet().approveCredit(CLI_ACTOR, {
      idempotencyKey: `test:approve:${randomUUID()}`,
      caseId: l.caseId,
      borrowerPersonId: purse.borrowerPersonId,
      amountRial: 1_000_000n,
      scope: purse.scope,
    });
    await wallet().charge(CLI_ACTOR, second.purseId, {
      idempotencyKey: `test:charge:${randomUUID()}`,
    });
    await repayment().createSchedule(CLI_ACTOR, {
      idempotencyKey: `test:schedule:${randomUUID()}`,
      purseId: second.purseId,
      installmentCount: 2,
      planFeeRial: 0n,
      ...(await scheduleVersionsNow(h)),
    });
    const caseRow = async () =>
      (
        await h.owner.query<Row>(
          `SELECT c.status, c.closed_at,
                  (SELECT count(*)::int FROM case_status_changes s
                   WHERE s.case_id = c.id AND s.to_status = 'completed') AS completions
           FROM cases c WHERE c.id = $1`,
          [l.caseId],
        )
      ).rows[0];
    const before = await caseRow();
    // The first schedule paid in full, in the same transaction as its settlement.
    const all = (await repayment().schedule(l.scheduleId)).outstandingRial;
    const paid = await slip(l, {
      amountRial: all.toString(),
      bankRef: `TRK-${randomUUID().slice(0, 8)}`,
    });
    expect((await approve(paid.body['paymentId'] as string)).status).toBe(200);
    const { rows } = await h.owner.query<Row>(
      `SELECT payload FROM outbox_events WHERE event_type = 'loan.settled'
       AND aggregate_id = $1`,
      [l.scheduleId],
    );
    expect(rows.map((r) => r['payload'])).toEqual([
      expect.objectContaining({ caseCompleted: false }),
    ]);
    // Refused: not completed, nothing recorded about it, the case as it was.
    expect(await caseRow()).toEqual(before);
    expect(before?.['status']).not.toBe('completed');
    expect(before?.['completions']).toBe(0);
  });

  it('doc 15 test 13: paid in full, settled once; the case completed only when all of its schedules are', async () => {
    const l = await loan();
    // A second loan of the same case (a treatment group, task 4-5), on its own purse.
    const second = await wallet().approveCredit(CLI_ACTOR, {
      idempotencyKey: `test:approve:${randomUUID()}`,
      caseId: l.caseId,
      borrowerPersonId: (await wallet().summary(l.purseId)).borrowerPersonId,
      amountRial: 2_000_000n,
      scope: (await wallet().summary(l.purseId)).scope,
    });
    await wallet().charge(CLI_ACTOR, second.purseId, {
      idempotencyKey: `test:charge:${randomUUID()}`,
    });
    const other = await repayment().createSchedule(CLI_ACTOR, {
      idempotencyKey: `test:schedule:${randomUUID()}`,
      purseId: second.purseId,
      installmentCount: 2,
      planFeeRial: 0n,
      ...(await scheduleVersionsNow(h)),
    });
    const status = async () =>
      (await h.owner.query<Row>('SELECT status FROM cases WHERE id = $1', [l.caseId])).rows[0]?.[
        'status'
      ];
    // Its advisor took it up (the chain's own step): a case still new is never completed
    // automatically, but left to staff (owner 1405/07/15; settled-case.int.test.ts).
    await h.owner.query("UPDATE cases SET status = 'advising' WHERE id = $1", [l.caseId]);
    const settledEvents = async () =>
      (
        await h.owner.query<Row>(
          `SELECT aggregate_id, payload FROM outbox_events WHERE event_type = 'loan.settled'
           AND payload->>'caseId' = $1`,
          [l.caseId],
        )
      ).rows;

    const all = (await repayment().schedule(l.scheduleId)).outstandingRial;
    const paid = await slip(l, {
      amountRial: all.toString(),
      bankRef: `TRK-${randomUUID().slice(0, 8)}`,
    });
    await approve(paid.body['paymentId'] as string);
    expect(await status()).not.toBe('completed');
    expect(await settledEvents()).toHaveLength(1);
    expect((await settledEvents())[0]?.['payload']).toMatchObject({ caseCompleted: false });

    const rest = await repayment().registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId: other.scheduleId,
      amountRial: (await repayment().schedule(other.scheduleId)).outstandingRial,
      receivedAt: new Date(),
    });
    await repayment().approvePayment(CLI_ACTOR, rest.paymentId);
    expect(await status()).toBe('completed');
    const events = await settledEvents();
    expect(events).toHaveLength(2);
    expect(events.find((e) => e['aggregate_id'] === other.scheduleId)?.['payload']).toMatchObject({
      caseCompleted: true,
    });
    // Approved again: no second settlement.
    await repayment().approvePayment(CLI_ACTOR, rest.paymentId);
    expect(await settledEvents()).toHaveLength(2);
    await sound();
  });

  it("the borrower's own schedule only; a file that is no document is refused", async () => {
    const mine = await loan();
    const theirs = await loan();
    const crossed = await slip(
      { patient: mine.patient, scheduleId: theirs.scheduleId },
      { amountRial: '100000', bankRef: `TRK-${randomUUID().slice(0, 8)}` },
    );
    expect(crossed.status).toBe(404);
    const notADocument = await slip(
      mine,
      { amountRial: '100000', bankRef: `TRK-${randomUUID().slice(0, 8)}` },
      Buffer.from('just text, no file signature'),
    );
    expect(notADocument.status).toBe(400);
    expect(notADocument.body['error']).toBe('unsupported_type');
    // Staff cannot use the borrower's path.
    expect(
      (
        await w.staff(finance, 'POST', '/me/repayment/receipts', {
          scheduleId: mine.scheduleId,
          amountRial: '100000',
          paidOn: '2026-10-05',
          bankRef: 'TRK-STAFF-1',
          payerName: 'کارمند',
        })
      ).status,
    ).toBe(403);
  });
});
