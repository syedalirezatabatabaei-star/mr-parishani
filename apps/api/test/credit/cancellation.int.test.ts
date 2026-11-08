import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEDGER, type LedgerPort } from '../../src/common/ledger/ledger.port';
import { DownPaymentReconciliation } from '../../src/modules/contract/down-payment-reconciliation';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { WorkerModule } from '../../src/worker.module';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from './funding-steps';
import { CREDIT_HARNESS, PDF, creditWorld, type Body, type Row } from './world';

/**
 * Task 4-8 [financial], part 3 (doc 12 §7; owner 1405/07/14): cancelling an application
 * before funding, asked by one person and approved by another in accounting. Every approved
 * receipt is refunded without penalty: the fees (origination; the plan fee paid at
 * completion) to fee.refund_payable, the down payment to downpayment.refund_payable. Nothing
 * of it may then be funded, completed or approved; the case is closed.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let finance2: Staff;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  finance2 = await w.role('accounting');
  steps = fundingSteps(h, w, { manager, finance });
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const ledger = () => h.app.get<LedgerPort>(LEDGER);

const ask = (who: Staff, creditApplicationId: string, reason = 'بیمار از درمان انصراف داد') =>
  w.staff(who, 'POST', '/credit/cancellations', { creditApplicationId, reason });
const approve = (who: Staff, id: string, reason = 'فیش‌ها بررسی شد') =>
  w.staff(who, 'POST', `/credit/cancellations/${id}/approve`, { reason });

/** What a borrower's liability account holds (credit minus debit); 0 without one. */
async function liability(entityId: string, code: string, borrowerPersonId: string) {
  const account = await ledger().findAccount({
    entityId,
    code,
    ownerType: 'borrower',
    ownerId: borrowerPersonId,
  });
  if (!account) return 0n;
  const b = await ledger().balanceOf(account.id);
  return b.creditRial - b.debitRial;
}

async function receiptsOf(applicationId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT id, kind, amount_rial::text AS amount, status FROM completion_receipts
     WHERE credit_application_id = $1 ORDER BY kind`,
    [applicationId],
  );
  return rows;
}

async function borrowerOf(applicationId: string) {
  const { rows } = await h.owner.query<Row>(
    'SELECT borrower_person_id, case_id FROM credit_applications WHERE id = $1',
    [applicationId],
  );
  return {
    personId: rows[0]?.['borrower_person_id'] as string,
    caseId: rows[0]?.['case_id'] as string,
  };
}

async function ledgerSound() {
  const { rows } = await h.owner.query<Row>(
    `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
     HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
  );
  expect(rows).toEqual([]);
  const ctx = worker as INestApplicationContext;
  expect(await ctx.get(LedgerReconciliation).run()).toMatchObject({ clean: true });
  expect(await ctx.get(DownPaymentReconciliation).run()).toMatchObject({ clean: true });
}

describe('cancelling an application before funding (task 4-8, part 3)', () => {
  it('refunds every approved receipt without penalty, closes the case, and nothing funds it after', async () => {
    const { patient, applicationId } = await steps.approved();
    const { receipts } = await steps.complete(patient, applicationId);
    const paid = await receiptsOf(applicationId);
    expect(paid.map((r) => r['kind'])).toContain('down_payment');
    expect(paid.map((r) => r['kind'])).toContain('origination_fee');

    const asked = await ask(w.completion, applicationId);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ status: 'requested', requestedByMe: true, refunds: null });
    // One open request per application.
    expect((await ask(finance, applicationId)).body['error']).toBe('request_open');

    const done = await approve(finance, asked.body['id'] as string);
    expect(done.status).toBe(201);
    expect(done.body['status']).toBe('approved');
    const refunds = done.body['refunds'] as Body[];
    // Each approved receipt, its own amount, its own document: nothing kept, no penalty.
    expect(
      refunds
        .map((r) => [r['kind'], r['amountRial']])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(paid.map((r) => [r['kind'], r['amount']]));

    const { rows: made } = await h.owner.query<Row>(
      'SELECT DISTINCT entity_id FROM completion_refunds WHERE credit_application_id = $1',
      [applicationId],
    );
    const entityId = made[0]?.['entity_id'] as string;
    const borrower = await borrowerOf(applicationId);
    const amount = (kind: string) =>
      BigInt((paid.find((r) => r['kind'] === kind)?.['amount'] as string | undefined) ?? '0');
    expect(await liability(entityId, 'downpayment.held', borrower.personId)).toBe(0n);
    expect(await liability(entityId, 'downpayment.refund_payable', borrower.personId)).toBe(
      amount('down_payment'),
    );
    expect(await liability(entityId, 'fee.refund_payable', borrower.personId)).toBe(
      amount('origination_fee') + amount('plan_fee'),
    );

    // The case closed as «انصراف از درمان».
    const { rows: cases } = await h.owner.query<Row>(
      'SELECT status, abandonment_reason_code FROM cases WHERE id = $1',
      [borrower.caseId],
    );
    expect(cases[0]?.['abandonment_reason_code']).toBe('treatment_cancelled');

    // Approving again changes nothing (rule 5).
    const again = await approve(finance, asked.body['id'] as string);
    expect(again.body['refunds']).toEqual(refunds);
    const { rows: count } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM completion_refunds WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(count[0]?.['n']).toBe(paid.length);

    // Nothing funds it, nor reverses what was refunded, nor cancels it twice.
    const funding = await w.staff(w.completion, 'POST', '/funding/requests', {
      creditApplicationId: applicationId,
    });
    expect(funding.status).toBe(409);
    expect(funding.body).toMatchObject({ error: 'not_approved', status: 'cancelled' });
    const reversed = await w.staff(
      finance2,
      'POST',
      `/receipts/${receipts['down_payment'] as string}/reverse-down-payment`,
      { reason: 'برگشت فیش' },
    );
    expect(reversed.status).toBe(409);
    expect(reversed.body['error']).toBe('refunded');
    expect((await ask(w.completion, applicationId)).body['error']).toBe('already_cancelled');
    await ledgerSound();
  });

  it('two people: the asker never decides; a rejection refunds nothing', async () => {
    const { patient, applicationId } = await steps.approved();
    await steps.complete(patient, applicationId);
    const asked = await ask(finance, applicationId);
    const same = await approve(finance, asked.body['id'] as string);
    expect(same.status).toBe(409);
    expect(same.body['error']).toBe('same_person');
    // Case completion asks, never decides.
    expect((await approve(w.completion, asked.body['id'] as string)).status).toBe(403);
    const rejected = await w.staff(
      finance2,
      'POST',
      `/credit/cancellations/${asked.body['id'] as string}/reject`,
      { reason: 'بیمار منصرف نشده است' },
    );
    expect(rejected.body['status']).toBe('rejected');
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM completion_refunds WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(rows[0]?.['n']).toBe(0);
    // Still fundable.
    expect(await steps.fund(applicationId)).toBeTruthy();
  });

  it('a funded application is not cancelled here: that is a cancellation after funding', async () => {
    const { patient, applicationId } = await steps.approved();
    await steps.complete(patient, applicationId);
    await steps.fund(applicationId);
    const asked = await ask(w.completion, applicationId);
    expect(asked.status).toBe(409);
    expect(asked.body['error']).toBe('already_funded');
  });

  it('before completion: a receipt waiting for finance is neither refunded nor approved after', async () => {
    const { patient, applicationId } = await steps.approved();
    const owed = (await w.staff(w.completion, 'GET', `/completion/${applicationId}`)).body[
      'owed'
    ] as Body[];
    const upload = async (kind: string) => {
      const form = new FormData();
      form.append('kind', kind);
      form.append('amountRial', owed.find((o) => o['kind'] === kind)?.['expectedRial']);
      form.append('paidOn', '2026-10-01');
      form.append('reference', `REF-${kind}`);
      form.append('file', new Blob([new Uint8Array(PDF)]), 'receipt.pdf');
      const res = await fetch(`${h.baseUrl}/me/completion/${applicationId}/receipts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${patient.token}` },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as Body };
    };
    const waiting = await upload('origination_fee');
    expect(waiting.status).toBe(201);
    const asked = await ask(w.completion, applicationId);
    const done = await approve(finance, asked.body['id'] as string);
    expect(done.body).toMatchObject({ status: 'approved', refunds: [] });
    // Approved after the cancellation, it would be income kept: refused.
    const late = await w.staff(
      finance2,
      'POST',
      `/receipts/${waiting.body['id'] as string}/approve`,
    );
    expect(late.status).toBe(409);
    expect(late.body['error']).toBe('application_cancelled');
    // Nor is a new one taken.
    expect((await upload('down_payment')).body).toMatchObject({
      error: 'not_approved',
      status: 'cancelled',
    });
    // A contract for it is refused.
    const contract = await w.staff(w.completion, 'POST', '/contracts', {
      creditApplicationId: applicationId,
    });
    expect(contract.status).toBe(409);
    expect(contract.body['status']).toBe('cancelled');
    await ledgerSound();
  });

  it('a funding and a cancellation at once: exactly one of them happens', async () => {
    const { patient, applicationId } = await steps.approved();
    await steps.complete(patient, applicationId);
    const funding = await w.staff(w.completion, 'POST', '/funding/requests', {
      creditApplicationId: applicationId,
    });
    const asked = await ask(w.completion, applicationId);
    const [funded, cancelled] = await Promise.all([
      w.staff(finance, 'POST', `/funding/requests/${funding.body['id'] as string}/approve`),
      approve(finance2, asked.body['id'] as string),
    ]);
    expect([funded.status, cancelled.status].sort()).toEqual([201, 409]);
    const { rows: purses } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM credit_purses WHERE credit_application_id = $1',
      [applicationId],
    );
    const { rows: refunds } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM completion_refunds WHERE credit_application_id = $1',
      [applicationId],
    );
    // Funded and nothing refunded, or refunded and nothing funded.
    expect([purses[0]?.['n'], (refunds[0]?.['n'] as number) > 0]).toEqual(
      funded.status === 201 ? [1, false] : [0, true],
    );
    await ledgerSound();
  });
});

// --- part 4: paying refunds out by bank (ADR-036; owner 1405/07/14) ------------------------

/** A completed application cancelled before funding: its receipts owed back. */
async function cancelledApplication() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const asked = await ask(w.completion, applicationId);
  expect((await approve(finance, asked.body['id'] as string)).status).toBe(201);
  return applicationId;
}

let seq = 0;
const pay = (
  who: Staff,
  creditApplicationId: string,
  fields: {
    account: 'fee' | 'down_payment';
    amountRial: string;
    bankReference?: string;
    idempotencyKey?: string;
  },
) => {
  seq += 1;
  return w.staff(who, 'POST', '/refund-payments', {
    creditApplicationId,
    paidOn: '2026-10-04',
    reason: 'واریز به حساب وام‌گیرنده',
    bankReference: `TRK-${String(Date.now())}-${String(seq)}`,
    idempotencyKey: `refund-test-${String(Date.now())}-${String(seq)}`,
    ...fields,
  });
};
const decide = (who: Staff, id: string, verb: 'approve' | 'reject' = 'approve') =>
  w.staff(who, 'POST', `/refund-payments/${id}/${verb}`, { reason: 'با صورت‌حساب بانک تطبیق شد' });
const owed = async (applicationId: string) =>
  (await w.staff(finance, 'GET', `/refund-payments/owed/${applicationId}`)).body;

describe('paying refunds out by bank (task 4-8, part 4)', () => {
  it('two people, part by part, never more than is owed; approving twice changes nothing', async () => {
    const applicationId = await cancelledApplication();
    const before = await owed(applicationId);
    const down = BigInt(before['downPaymentRial'] as string);
    const fee = BigInt(before['feeRial'] as string);
    expect(down).toBeGreaterThan(0n);
    expect(fee).toBeGreaterThan(0n);

    // More than is owed: refused when recorded.
    const over = await pay(finance, applicationId, {
      account: 'down_payment',
      amountRial: (down + 1n).toString(),
    });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ error: 'exceeds_owed', owedRial: down.toString() });

    // Part of it, with Persian digits in the tracking number.
    const half = down / 2n;
    const first = await pay(finance, applicationId, {
      account: 'down_payment',
      amountRial: half.toString(),
      bankReference: '۹۸۷۶۵۴۳۲۱',
      idempotencyKey: `refund-same-${applicationId}`,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'requested', bankReference: '987654321' });
    // The same request sent twice records one; the same key with other content is refused.
    const replay = await pay(finance, applicationId, {
      account: 'down_payment',
      amountRial: half.toString(),
      bankReference: '987654321',
      idempotencyKey: `refund-same-${applicationId}`,
    });
    expect(replay.body['id']).toBe(first.body['id']);
    const reused = await pay(finance, applicationId, {
      account: 'down_payment',
      amountRial: '1000',
      idempotencyKey: `refund-same-${applicationId}`,
    });
    expect(reused.body['error']).toBe('idempotency_key_reused');
    // The same tracking number again: refused.
    const twice = await pay(finance, applicationId, {
      account: 'fee',
      amountRial: '1000',
      bankReference: '987654321',
    });
    expect(twice.status).toBe(409);
    expect(twice.body['error']).toBe('bank_reference_used');

    // Who recorded it never approves it; nothing is posted until approved.
    const same = await decide(finance, first.body['id'] as string);
    expect(same.status).toBe(409);
    expect(same.body['error']).toBe('same_person');
    expect((await owed(applicationId))['downPaymentRial']).toBe(down.toString());
    const done = await decide(finance2, first.body['id'] as string);
    expect(done.status).toBe(201);
    expect(done.body['status']).toBe('approved');
    const again = await decide(finance2, first.body['id'] as string);
    expect(again.body['journalEntryId']).toBe(done.body['journalEntryId']);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1`,
      [`refund-payment:${first.body['id'] as string}`],
    );
    expect(rows[0]?.['n']).toBe(1);
    expect((await owed(applicationId))['downPaymentRial']).toBe((down - half).toString());

    // The rest, and the fees: nothing left owed, the accounts never below zero.
    const rest = await pay(finance2, applicationId, {
      account: 'down_payment',
      amountRial: (down - half).toString(),
    });
    expect((await decide(finance, rest.body['id'] as string)).status).toBe(201);
    const fees = await pay(finance2, applicationId, { account: 'fee', amountRial: fee.toString() });
    expect((await decide(finance, fees.body['id'] as string)).status).toBe(201);
    expect(await owed(applicationId)).toMatchObject({ feeRial: '0', downPaymentRial: '0' });
    await ledgerSound();
  });

  it('two payments each within what is owed, together more: the second is refused when approved', async () => {
    const applicationId = await cancelledApplication();
    const fee = BigInt((await owed(applicationId))['feeRial'] as string);
    const a = await pay(finance, applicationId, { account: 'fee', amountRial: fee.toString() });
    const b = await pay(finance, applicationId, { account: 'fee', amountRial: fee.toString() });
    expect([a.status, b.status]).toEqual([201, 201]);
    const [x, y] = await Promise.all([
      decide(finance2, a.body['id'] as string),
      decide(finance2, b.body['id'] as string),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x.body['error'], y.body['error']]).toContain('exceeds_owed');
    expect((await owed(applicationId))['feeRial']).toBe('0');
    // A rejected payment frees its tracking number.
    const c = await pay(finance, applicationId, {
      account: 'down_payment',
      amountRial: '1000',
      bankReference: `FREE-${applicationId.slice(0, 8)}`,
    });
    expect((await decide(finance2, c.body['id'] as string, 'reject')).body['status']).toBe(
      'rejected',
    );
    const d = await pay(finance, applicationId, {
      account: 'down_payment',
      amountRial: '1000',
      bankReference: `FREE-${applicationId.slice(0, 8)}`,
    });
    expect(d.status).toBe(201);
    await ledgerSound();
  });
});
