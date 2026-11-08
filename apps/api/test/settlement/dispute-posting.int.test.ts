import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { toJalali } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { LEDGER, type LedgerPort } from '../../src/common/ledger/ledger.port';
import { REPAYMENT, type RepaymentPort } from '../../src/common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../src/common/wallet/wallet.port';
import { DownPaymentReconciliation } from '../../src/modules/contract/down-payment-reconciliation';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { postingKey } from '../../src/modules/settlement/dispute.service';
import { SettlementReconciliation } from '../../src/modules/settlement/settlement-reconciliation';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { StatementService } from '../../src/modules/settlement/statement.service';
import { WorkerModule } from '../../src/worker.module';
import {
  CapturingTextSender,
  startHarness,
  type Harness,
  type loggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 5-2b [financial] (ADR-038; doc 02 §8 test 8; owner 1405/07/15): an accepted payable
 * dispute posted takes the service back, in one transaction, by someone other than its
 * opener: finalize and the registration reversed, the reservation cancelled by exactly that
 * amount, the fee reversed. On a closed purse, the rule of 4-8: the loan's part off the
 * schedule from the last untouched installment, the rest to the down payment's refund; the
 * purse stays closed. Posted again: nothing new.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let finance2: Staff;
let finance3: Staff;
let advisor: Staff;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  finance2 = await w.role('accounting');
  finance3 = await w.role('accounting');
  advisor = await w.role('advisor');
  steps = fundingSteps(h, w, { manager, finance });
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const wallet = () => h.app.get<WalletPort>(WALLET);
const repayment = () => h.app.get<RepaymentPort>(REPAYMENT);
const ledger = () => h.app.get<LedgerPort>(LEDGER);
const settlement = () => h.app.get(SettlementService);

async function setRate(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}

async function fundedPurse() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const { rows } = await h.owner.query<Row>(
    'SELECT schedule_id FROM funding_requests WHERE purse_id = $1',
    [purseId],
  );
  return { patient, purseId, scheduleId: rows[0]?.['schedule_id'] as string };
}
type Purse = Awaited<ReturnType<typeof fundedPurse>>;

const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

/** One proforma line authorized; with `deliver`, its code entered: final, its payable made. */
async function service(f: Purse, line: number, deliver = true) {
  const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
    purseId: f.purseId,
    proformaLineIds: [lines[line]?.['id']],
  });
  expect(made.status).toBe(201);
  const id = made.body['id'] as string;
  if (!deliver) return { id, payableId: '', amount: BigInt(made.body['amountRial'] as string) };
  // A fee of 10%, locked when the service becomes final.
  await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 1000 });
  try {
    const done = await w.staff(w.doctor, 'POST', `/service/authorizations/${id}/deliver`, {
      code: lastCode(f.patient.mobile),
    });
    expect(done.body['status']).toBe('finalized');
  } finally {
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 0 });
  }
  const { payableId } = await settlement().accrue(CLI_ACTOR, id);
  const { rows } = await h.owner.query<Row>(
    'SELECT amount_rial::text AS amount FROM doctor_payables WHERE id = $1',
    [payableId],
  );
  return { id, payableId, amount: BigInt(rows[0]?.['amount'] as string) };
}

/** Opened by finance, accepted by finance2: accepted_pending_posting (5-2). */
async function accepted(payableId: string) {
  const opened = await w.staff(finance, 'POST', '/settlement/disputes', {
    subjectType: 'doctor_payable',
    subjectId: payableId,
    reason: 'خدمت انجام نشده است',
  });
  expect(opened.status).toBe(201);
  const id = opened.body['id'] as string;
  const decided = await w.staff(finance2, 'POST', `/settlement/disputes/${id}/resolve`, {
    outcome: 'accepted',
    note: 'پذیرفته شد',
  });
  expect(decided.body['status']).toBe('accepted_pending_posting');
  return id;
}

const post = (who: Staff, id: string) => w.staff(who, 'POST', `/settlement/disputes/${id}/post`);

async function account(code: string, ownerType: 'doctor' | 'company', ownerId: string | null) {
  const found = await ledger().findAccount({ entityId: 'aramesh', code, ownerType, ownerId });
  if (!found) return 0n;
  const b = await ledger().balanceOf(found.id);
  return b.debitRial - b.creditRial;
}

/** Everything the posting moves: the purse's chain, the doctor's and the company's. */
async function snapshot(purseId: string, doctorNodeId: string) {
  const purse = await wallet().summary(purseId);
  return {
    balances: purse.balances,
    payable: await account('doctor.payable', 'doctor', doctorNodeId),
    feeReceivable: await account('doctor.fee_receivable', 'doctor', doctorNodeId),
    income: await account('company.fee_income', 'company', null),
  };
}

async function nodeOf(purseId: string) {
  const s = await wallet().summary(purseId);
  return s.scope.doctorNodeId;
}

async function statusOf(payableId: string, authorizationId: string, disputeId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT p.status AS payable, f.status AS fee, a.status AS service, d.status AS dispute
     FROM doctor_payables p
     JOIN service_fees f ON f.doctor_payable_id = p.id
     JOIN service_authorizations a ON a.id = $2
     JOIN financial_disputes d ON d.id = $3
     WHERE p.id = $1`,
    [payableId, authorizationId, disputeId],
  );
  return rows[0];
}

async function journalsOf(disputeId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT count(*)::int AS n FROM journal_entries
     WHERE idempotency_key LIKE $1 OR idempotency_key LIKE $2`,
    [`settlement:dispute:${disputeId}:%`, `wallet:settlement:dispute:${disputeId}:%`],
  );
  return rows[0]?.['n'] as number;
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
  expect(await ctx.get(DownPaymentReconciliation).run()).toMatchObject({ clean: true });
}

/** 4-8: all that is unused cancelled by two; the purse closes. */
async function close(f: Purse) {
  const asked = await w.staff(finance, 'POST', '/wallet/special-operations', {
    kind: 'cancel_unused',
    purseId: f.purseId,
    reason: 'بیمار درمان را نیمه‌کاره گذاشت',
  });
  expect(asked.status).toBe(201);
  const approved = await w.staff(
    finance2,
    'POST',
    `/wallet/special-operations/${asked.body['id'] as string}/approve`,
    { reason: 'تأیید مالی دوم' },
  );
  expect(approved.status).toBe(201);
  expect((await wallet().summary(f.purseId)).status).toBe('closed');
}

describe('posting an accepted payable dispute (task 5-2b)', () => {
  it('doc 02 test 8, an open purse: every balance back to before the service; two people', async () => {
    const f = await fundedPurse();
    const node = await nodeOf(f.purseId);
    const before = await snapshot(f.purseId, node);
    const s = await service(f, 0);
    const id = await accepted(s.payableId);

    // Not the opener; not without the permission.
    const alone = await post(finance, id);
    expect(alone.status).toBe(409);
    expect(alone.body['error']).toBe('same_person');
    expect((await post(advisor, id)).status).toBe(403);
    expect((await post(w.doctor, id)).status).toBe(403);

    const done = await post(finance3, id);
    expect(done.status).toBe(201);
    expect(done.body['status']).toBe('resolved_accepted');
    expect(await snapshot(f.purseId, node)).toEqual(before);
    expect(await statusOf(s.payableId, s.id, id)).toEqual({
      payable: 'reversed',
      fee: 'reversed',
      service: 'reversed',
      dispute: 'resolved_accepted',
    });
    const { rows } = await h.owner.query<Row>(
      'SELECT step FROM settlement_dispute_postings WHERE dispute_id = $1 ORDER BY step',
      [id],
    );
    expect(rows.map((r) => r['step'])).toEqual(['fee', 'unfinalize', 'unregister', 'unreserve']);
    // Never accrued again, never in a statement.
    await expect(settlement().accrue(CLI_ACTOR, s.id)).rejects.toMatchObject({
      response: { error: 'service_not_final' },
    });
    const view = await w.staff(w.doctor, 'GET', `/service/authorizations/${s.id}`);
    expect(view.body['status']).toBe('reversed');
    await sound();
  });

  it('the reservation only by the service: another authorization keeps its own', async () => {
    const f = await fundedPurse();
    const s = await service(f, 0);
    const other = await service(f, 1, false);
    const before = await wallet().summary(f.purseId);
    expect(before.balances.reservedRial).toBe(other.amount);
    const id = await accepted(s.payableId);
    expect((await post(finance3, id)).status).toBe(201);
    const after = await wallet().summary(f.purseId);
    expect(after.balances.reservedRial).toBe(other.amount);
    expect(after.balances.availableRial).toBe(before.balances.availableRial + s.amount);
    await sound();
  });

  it('posted again, or twice at once: one set of documents', async () => {
    const f = await fundedPurse();
    const s = await service(f, 0);
    const id = await accepted(s.payableId);
    const both = await Promise.all([post(finance3, id), post(finance2, id)]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    const n = await journalsOf(id);
    expect(n).toBe(4);
    expect((await post(finance3, id)).body['status']).toBe('resolved_accepted');
    expect(await journalsOf(id)).toBe(n);
    await sound();
  });

  it('a closed purse (the rule of 4-8): the loan part off the last untouched installments, the paid one untouched, the rest to the refund; it stays closed', async () => {
    const f = await fundedPurse();
    const schedule = await repayment().schedule(f.scheduleId);
    const first = schedule.installments[0]?.amountRial ?? 0n;
    // The first installment paid.
    const paid = await repayment().registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId: f.scheduleId,
      amountRial: first,
      receivedAt: new Date(),
    });
    await repayment().approvePayment(CLI_ACTOR, paid.paymentId);
    const s = await service(f, 1);
    await close(f);
    const id = await accepted(s.payableId);

    // What comes back is the loan's first (ADR-036): known before posting.
    const debtBefore = (await wallet().summary(f.purseId)).balances;
    const scheduleBefore = await repayment().schedule(f.scheduleId);
    const untouched = scheduleBefore.installments
      .filter((i) => i.paidRial === 0n)
      .reduce((sum, i) => sum + i.amountRial, 0n);

    const done = await post(finance3, id);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const { rows } = await h.owner.query<Row>(
      `SELECT step, amount_rial::text AS amount FROM settlement_dispute_postings
       WHERE dispute_id = $1 AND step IN ('schedule', 'refund') ORDER BY step`,
      [id],
    );
    const loanPart = BigInt(
      (rows.find((r) => r['step'] === 'schedule')?.['amount'] as string | undefined) ?? '0',
    );
    expect(rows.find((r) => r['step'] === 'refund')?.['amount']).toBe(s.amount.toString());
    expect(loanPart <= untouched).toBe(true);

    const after = await repayment().schedule(f.scheduleId);
    // The paid installment untouched; none negative; the schedule smaller by the loan part.
    expect(after.installments[0]?.amountRial).toBe(first);
    expect(after.installments.every((i) => i.amountRial >= 0n)).toBe(true);
    expect(scheduleBefore.totalRial - after.totalRial).toBe(loanPart);
    const purse = await wallet().summary(f.purseId);
    expect(purse.status).toBe('closed');
    expect(purse.balances.availableRial).toBe(0n);
    expect(purse.balances.reservedRial).toBe(debtBefore.reservedRial);
    await sound();
  });

  it('a closed purse: more than the untouched installments refused whole, nothing posted', async () => {
    const f = await fundedPurse();
    const s = await service(f, 1);
    await close(f);
    const id = await accepted(s.payableId);
    // Every installment paid: none untouched is left for the loan's part that comes back
    // (the service is more than the down payment, so some of it was the loan's).
    const sched = await repayment().schedule(f.scheduleId);
    const untouched = sched.installments
      .filter((i) => i.paidRial === 0n)
      .reduce((sum, i) => sum + i.amountRial, 0n);
    const pay = await repayment().registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId: f.scheduleId,
      amountRial: untouched,
      receivedAt: new Date(),
    });
    await repayment().approvePayment(CLI_ACTOR, pay.paymentId);
    const before = await wallet().summary(f.purseId);
    const ops = async () =>
      (
        await h.owner.query<Row>(
          'SELECT count(*)::int AS n FROM purse_operations WHERE purse_id = $1',
          [f.purseId],
        )
      ).rows[0]?.['n'];
    const opsBefore = await ops();

    const refused = await post(finance3, id);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('exceeds_unpaid_installments');
    expect(await ops()).toBe(opsBefore);
    expect(await journalsOf(id)).toBe(0);
    expect((await wallet().summary(f.purseId)).balances).toEqual(before.balances);
    expect(await statusOf(s.payableId, s.id, id)).toMatchObject({
      payable: 'on_hold',
      service: 'finalized',
      dispute: 'accepted_pending_posting',
    });
    await sound();
  });

  it('in a live draft statement: refused until the draft is cancelled', async () => {
    const f = await fundedPurse();
    const s = await service(f, 0);
    const { rows } = await h.owner.query<Row>(
      'SELECT doctor_id, due_at FROM doctor_payables WHERE id = $1',
      [s.payableId],
    );
    const dueAt = rows[0]?.['due_at'] as Date;
    await settlement().markDue(dueAt);
    const j = toJalali(dueAt);
    const draft = (
      await h.app
        .get(StatementService)
        .generateFor(CLI_ACTOR, rows[0]?.['doctor_id'] as string, j.year, j.month)
    )?.statementId as string;
    const id = await accepted(s.payableId);
    const refused = await post(finance3, id);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('statement_must_be_cancelled');
    for (const who of [finance, finance2]) {
      await w.staff(who, 'POST', `/settlement/statements/${draft}/cancel`, { reason: 'اختلاف' });
    }
    expect((await post(finance3, id)).status).toBe(201);
    await sound();
  });

  it('the database: only the new paths', async () => {
    const f = await fundedPurse();
    const s = await service(f, 0);
    const id = await accepted(s.payableId);
    await post(finance3, id);
    await expect(
      h.owner.query("UPDATE financial_disputes SET status = 'open' WHERE id = $1", [id]),
    ).rejects.toThrow(/cannot go from resolved_accepted to open/);
    await expect(
      h.owner.query("UPDATE service_authorizations SET status = 'finalized' WHERE id = $1", [s.id]),
    ).rejects.toThrow(/cannot go from reversed to finalized/);
    // Only a final service is reversed, and with its moment.
    const other = await service(f, 1, false);
    await expect(
      h.owner.query(
        "UPDATE service_authorizations SET status = 'reversed', reversed_at = now() WHERE id = $1",
        [other.id],
      ),
    ).rejects.toThrow(/cannot go from code_sent to reversed/);
    expect(postingKey(id, 'refund')).toBe(`settlement:dispute:${id}:refund`);
  });
});
