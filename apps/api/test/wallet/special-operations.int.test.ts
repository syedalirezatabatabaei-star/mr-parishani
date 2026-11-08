import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { planFeeShares } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { LEDGER, type LedgerPort } from '../../src/common/ledger/ledger.port';
import { REPAYMENT, type RepaymentPort } from '../../src/common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../src/common/wallet/wallet.port';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { DownPaymentReconciliation } from '../../src/modules/contract/down-payment-reconciliation';
import { WorkerModule } from '../../src/worker.module';
import {
  COMPLETION_REFUNDS,
  type CompletionRefundsPort,
} from '../../src/common/contract/completion-refunds.port';
import { PenaltyOverrideService } from '../../src/modules/credit/penalty-override.service';
import { CREDIT_CONTRACT_FACTS } from '../../src/common/credit/credit-contract-facts.port';
import { PROFORMA_DIRECTORY } from '../../src/common/proforma/proforma-directory.port';
import { WORKPLACE_DIRECTORY } from '../../src/common/catalog/workplace-directory.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { DoctorPatientsProjector } from '../../src/modules/service/doctor-patients.projector';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import {
  CapturingTextSender,
  startHarness,
  type Harness,
  type loggedInAccount,
} from '../identity/harness';
import { councilNumber, nationalId } from '../catalog/fixtures';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, PLAN, type Body, type Row } from '../credit/world';

/**
 * Task 4-8 [financial], part 1 (doc 12 §7; doc 02 §6, §8-8; owner 1405/07/13): cancelling
 * what is unused, all or part, asked by one person in finance and approved by another.
 * ADR-034's order (the down payment used first, the loan cancelled first, owner پ۱); the
 * loan's part off the debt and off the last untouched installments by a new revision
 * (owner الف, ب, ج, پ۶, پ۷); the down payment's to downpayment.refund_payable (ADR-036);
 * a reversal puts everything back exactly (doc 02 §8-8).
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let finance2: Staff;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

const LOAN = 9_600_000n;
const DOWN = 2_400_000n;
const FEE = 960_000n;

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
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

const wallet = () => h.app.get<WalletPort>(WALLET);
const repayment = () => h.app.get<RepaymentPort>(REPAYMENT);
const ledger = () => h.app.get<LedgerPort>(LEDGER);

async function fundedPurse() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const { rows } = await h.owner.query<Row>(
    `SELECT schedule_id FROM funding_requests WHERE purse_id = $1`,
    [purseId],
  );
  return { patient, applicationId, purseId, scheduleId: rows[0]?.['schedule_id'] as string };
}

const ask = (who: Staff, body: Record<string, unknown>) =>
  w.staff(who, 'POST', '/wallet/special-operations', body);
const approve = (who: Staff, id: string, reason = 'تأیید مالی دوم') =>
  w.staff(who, 'POST', `/wallet/special-operations/${id}/approve`, { reason });

async function refundOf(purseId: string) {
  const summary = await wallet().summary(purseId);
  const { rows } = await h.owner.query<Row>(
    'SELECT borrower_person_id FROM credit_purses WHERE id = $1',
    [purseId],
  );
  const account = await ledger().findAccount({
    entityId: summary.entityId,
    code: 'downpayment.refund_payable',
    ownerType: 'borrower',
    ownerId: rows[0]?.['borrower_person_id'] as string,
  });
  if (!account) return 0n;
  const b = await ledger().balanceOf(account.id);
  return b.creditRial - b.debitRial;
}

async function snapshot(purseId: string, scheduleId: string) {
  const purse = await wallet().summary(purseId);
  const schedule = await repayment().schedule(scheduleId);
  return {
    balances: purse.balances,
    refund: await refundOf(purseId),
    total: schedule.totalRial,
    installments: schedule.installments.map((i) => [i.index, i.amountRial, i.status]),
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

describe('cancelling what is unused (task 4-8, part 1)', () => {
  it('ADR-034 order: 10,000,000 of an unused purse is the whole loan and 400,000 of the down payment', async () => {
    const f = await fundedPurse();
    expect(await wallet().unusedOf(f.purseId)).toEqual({ loanRial: LOAN, downPaymentRial: DOWN });
    const asked = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      amountRial: '10000000',
      reason: 'بیمار درمان را نیمه‌کاره گذاشت',
    });
    expect(asked.status).toBe(201);
    const id = asked.body['id'] as string;

    // Two people (doc 12 §7): never the one who asked.
    const self = await approve(finance, id);
    expect(self.status).toBe(409);
    expect(self.body['error']).toBe('same_person');

    const done = await approve(finance2, id);
    expect(done.status).toBe(201);
    expect(done.body['result']).toMatchObject({
      amountRial: '10000000',
      loanRial: '9600000',
      downPaymentRial: '400000',
    });
    const purse = await wallet().summary(f.purseId);
    expect(purse.balances.availableRial).toBe(2_000_000n);
    // The loan's part off the debt; the plan fee stays (owner پ۵).
    expect(purse.balances.borrowerDebtRial).toBe(FEE);
    expect(await refundOf(f.purseId)).toBe(400_000n);
    // The schedule: down by the loan's part exactly, from the last installments back.
    const schedule = await repayment().schedule(f.scheduleId);
    expect(schedule.totalRial).toBe(LOAN + FEE - LOAN);
    const amounts = schedule.installments.map((i) => i.amountRial);
    expect(amounts.reduce((s, a) => s + a, 0n)).toBe(FEE);
    const firstZero = amounts.findIndex((a) => a === 0n);
    expect(amounts.slice(firstZero).every((a) => a === 0n)).toBe(true);
    expect(amounts.every((a) => a >= 0n)).toBe(true);
    expect(schedule.installments.filter((i) => i.status === 'cancelled').length).toBeGreaterThan(0);
    // The installments themselves were never updated (owner ج): only a revision was added.
    const { rows } = await h.owner.query<Row>(
      `SELECT (SELECT sum(amount_rial)::text FROM installments WHERE schedule_id = $1) AS original,
              (SELECT count(*)::int FROM installment_schedule_revisions WHERE schedule_id = $1) AS revisions`,
      [f.scheduleId],
    );
    expect(rows[0]).toEqual({ original: String(LOAN + FEE), revisions: 1 });

    // Owner الف: never more than what is unused.
    const more = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      amountRial: '2000001',
      reason: 'بیش از مانده',
    });
    const refused = await approve(finance2, more.body['id'] as string);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('exceeds_unused');
    expect((await wallet().summary(f.purseId)).balances.availableRial).toBe(2_000_000n);
    await w.staff(
      finance2,
      'POST',
      `/wallet/special-operations/${more.body['id'] as string}/reject`,
      {
        reason: 'بیش از مانده',
      },
    );
    await ledgerSound();
  });

  it('after use: the down payment was used first, so a cancellation is the loan only', async () => {
    const f = await fundedPurse();
    // 3,000,000 used by a registered service: all of it from the down payment... and 600,000
    // of the loan (2,400,000 + 600,000).
    await wallet().reserve(CLI_ACTOR, f.purseId, {
      idempotencyKey: `test:reserve:${randomUUID()}`,
      authorizationId: 'auth-1',
      amountRial: 3_000_000n,
      service: (await wallet().summary(f.purseId)).scope,
    });
    await wallet().registerService(CLI_ACTOR, f.purseId, {
      idempotencyKey: `test:register:${randomUUID()}`,
      authorizationId: 'auth-1',
      amountRial: 3_000_000n,
    });
    expect(await wallet().unusedOf(f.purseId)).toEqual({
      loanRial: LOAN - 600_000n,
      downPaymentRial: 0n,
    });
    const asked = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      reason: 'ابطال همه مانده',
    });
    const done = await approve(finance2, asked.body['id'] as string);
    expect(done.body['result']).toMatchObject({
      amountRial: String(LOAN - 600_000n),
      loanRial: String(LOAN - 600_000n),
      downPaymentRial: '0',
    });
    expect(await refundOf(f.purseId)).toBe(0n);
    // Something is still pending (the registered service): the purse stays open.
    expect((await wallet().summary(f.purseId)).status).toBe('funded');
    await ledgerSound();
  });

  it('approved twice at once, or again: one document, one revision (rule 5)', async () => {
    const f = await fundedPurse();
    const asked = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      amountRial: '1000000',
      reason: 'ابطال بخشی',
    });
    const id = asked.body['id'] as string;
    const third = await w.role('accounting');
    const [one, two] = await Promise.all([approve(finance2, id), approve(third, id)]);
    const both = [one, two];
    for (const r of both) expect(r.status).toBe(201);
    expect(one.body['result']).toEqual(two.body['result']);
    expect((await approve(finance2, id)).body['result']).toEqual(one.body['result']);
    const { rows } = await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM purse_operations WHERE purse_id = $1 AND kind = 'cancel_unused') AS ops,
              (SELECT count(*)::int FROM installment_schedule_revisions WHERE schedule_id = $2) AS revisions`,
      [f.purseId, f.scheduleId],
    );
    expect(rows[0]).toEqual({ ops: 1, revisions: 1 });
  });

  it('doc 02 §8-8: reversed, every balance and installment is exactly as before; once only', async () => {
    const f = await fundedPurse();
    const before = await snapshot(f.purseId, f.scheduleId);
    const asked = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      amountRial: '11000000',
      reason: 'ابطال',
    });
    const cancelId = asked.body['id'] as string;
    await approve(finance2, cancelId);
    expect(await snapshot(f.purseId, f.scheduleId)).not.toEqual(before);

    const back = await ask(finance, {
      kind: 'reverse_cancel_unused',
      requestId: cancelId,
      reason: 'ابطال به اشتباه ثبت شد',
    });
    expect(back.status).toBe(201);
    expect((await approve(finance, back.body['id'] as string)).status).toBe(409);
    const reversed = await approve(finance2, back.body['id'] as string);
    expect(reversed.status).toBe(201);
    expect(await snapshot(f.purseId, f.scheduleId)).toEqual(before);
    // Never twice.
    const again = await ask(finance, {
      kind: 'reverse_cancel_unused',
      requestId: cancelId,
      reason: 'دوباره',
    });
    expect(again.status).toBe(409);
    await ledgerSound();
  });

  it('owner پ۶ and پ۷: paid or partly paid installments untouched; more than the rest refused whole', async () => {
    const f = await fundedPurse();
    const schedule = await repayment().schedule(f.scheduleId);
    const first = schedule.installments[0]?.amountRial ?? 0n;
    // The first installment paid, the second partly.
    const paid = await repayment().registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId: f.scheduleId,
      amountRial: first + 1_000n,
      receivedAt: new Date(),
    });
    await repayment().approvePayment(CLI_ACTOR, paid.paymentId);
    const untouched = (await repayment().schedule(f.scheduleId)).installments
      .filter((i) => i.paidRial === 0n)
      .reduce((s, i) => s + i.amountRial, 0n);

    // More than the untouched installments: refused, nothing done.
    const tooMuch = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      amountRial: String(untouched + 1n),
      reason: 'بیش از اقساط',
    });
    const refused = await approve(finance2, tooMuch.body['id'] as string);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('exceeds_unpaid_installments');
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM purse_operations WHERE purse_id = $1 AND kind = 'cancel_unused'`,
      [f.purseId],
    );
    expect(rows[0]).toEqual({ n: 0 });
    await w.staff(
      finance2,
      'POST',
      `/wallet/special-operations/${tooMuch.body['id'] as string}/reject`,
      {
        reason: 'بیش از اقساط',
      },
    );

    // All of the untouched: every one of them goes to zero; the two paid ones stay.
    const all = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      amountRial: String(untouched),
      reason: 'همه اقساط پرداخت‌نشده',
    });
    expect((await approve(finance2, all.body['id'] as string)).status).toBe(201);
    const after = (await repayment().schedule(f.scheduleId)).installments;
    expect(after[0]?.amountRial).toBe(first);
    expect(after[1]?.amountRial).toBe(schedule.installments[1]?.amountRial);
    expect(after.slice(2).every((i) => i.amountRial === 0n && i.status === 'cancelled')).toBe(true);
    await ledgerSound();
  });

  it('a cancellation that closed the purse is final: its reversal is refused', async () => {
    const f = await fundedPurse();
    const asked = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      reason: 'انصراف کامل',
    });
    const done = await approve(finance2, asked.body['id'] as string);
    expect(done.body['result']).toMatchObject({
      loanRial: String(LOAN),
      downPaymentRial: String(DOWN),
    });
    expect((await wallet().summary(f.purseId)).status).toBe('closed');
    const back = await ask(finance, {
      kind: 'reverse_cancel_unused',
      requestId: asked.body['id'],
      reason: 'برگشت',
    });
    const refused = await approve(finance2, back.body['id'] as string);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('purse_closed');
    await ledgerSound();
  });

  it('a cancellation and a reservation at once never take the purse below zero', async () => {
    const f = await fundedPurse();
    const asked = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      amountRial: '8000000',
      reason: 'هم‌زمانی',
    });
    const scope = (await wallet().summary(f.purseId)).scope;
    const results = await Promise.allSettled([
      approve(finance2, asked.body['id'] as string),
      wallet().reserve(CLI_ACTOR, f.purseId, {
        idempotencyKey: `test:reserve:${randomUUID()}`,
        authorizationId: 'race-1',
        amountRial: 6_000_000n,
        service: scope,
      }),
    ]);
    const purse = await wallet().summary(f.purseId);
    expect(purse.balances.availableRial >= 0n).toBe(true);
    // Both fitted (8,000,000 + 6,000,000 > 12,000,000 cannot): one of them was refused.
    const cancelled =
      results[0].status === 'fulfilled' && (results[0].value as { status: number }).status === 201;
    const reserved = results[1].status === 'fulfilled';
    expect(cancelled && reserved).toBe(false);
    await ledgerSound();
  });

  it('only finance asks and decides; a purse not funded is refused', async () => {
    const f = await fundedPurse();
    const byCompletion = await ask(w.completion, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      reason: 'نه مالی',
    });
    expect(byCompletion.status).toBe(403);
    const list = await w.staff(finance2, 'GET', `/wallet/special-operations?purseId=${f.purseId}`);
    expect(list.status).toBe(200);
    expect(list.body as unknown as Body[]).toEqual([]);
  });
});

// --- part 2: a new doctor (doc 12 §7, §9 test 12; owner پ۲, پ۳, پ۹) ---------------------

/** What the worker does on wallet.funded and wallet.doctor_changed (task 4-6, 4-8). */
async function project(type: 'wallet.funded' | 'wallet.doctor_changed', payload: Body) {
  const projector = new DoctorPatientsProjector(
    { register: () => undefined },
    h.app.get(CREDIT_CONTRACT_FACTS),
    h.app.get(PROFORMA_DIRECTORY),
    h.app.get(WORKPLACE_DIRECTORY),
    h.app.get(WALLET),
  );
  await h.app.get<Database>(DATABASE).transaction((tx) =>
    projector.handle(
      {
        id: randomUUID(),
        type,
        aggregateType: 'test',
        aggregateId: randomUUID(),
        payload,
        occurredAt: new Date().toISOString(),
      },
      tx,
    ),
  );
}

const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

describe('a new doctor (task 4-8, part 2; doc 12 §9 test 12)', () => {
  it('moves the scope only: open authorizations cancelled, the balance unmoved; the old doctor reaches nothing', async () => {
    const f = await fundedPurse();
    await project('wallet.funded', { creditApplicationId: f.applicationId, purseId: f.purseId });
    const creditManager = await w.role('credit_manager');
    const w2 = await creditWorld(h);
    const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
      'lines'
    ] as Body[];
    const open = await w.staff(w.doctor, 'POST', '/service/authorizations', {
      purseId: f.purseId,
      proformaLineIds: [lines[0]?.['id']],
    });
    expect(open.status).toBe(201);
    const before = await wallet().summary(f.purseId);

    const asked = await w.staff(w.completion, 'POST', '/wallet/special-operations', {
      kind: 'change_doctor',
      purseId: f.purseId,
      workplaceId: w2.workplaceId,
      reason: 'بیمار از پزشک ناراضی است',
    });
    expect(asked.status).toBe(201);
    // Finance cannot decide a doctor change; the asker never decides it (owner پ۳).
    expect((await approve(finance2, asked.body['id'] as string)).status).toBe(403);
    const done = await approve(creditManager, asked.body['id'] as string);
    expect(done.status).toBe(201);
    expect(done.body['result']).toMatchObject({ cancelledAuthorizations: 1 });

    const after = await wallet().summary(f.purseId);
    // Doc 12 §9 test 12: the balance is the same; only the reservation is back.
    expect(after.approvedAmountRial).toBe(before.approvedAmountRial);
    expect(after.downPaymentRial).toBe(before.downPaymentRial);
    expect(after.balances.borrowerDebtRial).toBe(before.balances.borrowerDebtRial);
    expect(after.balances.reservedRial).toBe(0n);
    expect(after.balances.availableRial).toBe(LOAN + DOWN);
    expect(after.scope.doctorNodeId).not.toBe(before.scope.doctorNodeId);
    const { rows } = await h.owner.query<Row>(
      'SELECT status FROM service_authorizations WHERE id = $1',
      [open.body['id']],
    );
    expect(rows[0]).toEqual({ status: 'cancelled' });

    // The old doctor reaches nothing of it; the new one authorizes.
    expect(
      (
        await w.staff(w.doctor, 'POST', '/service/authorizations', {
          purseId: f.purseId,
          proformaLineIds: [lines[1]?.['id']],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await w.staff(w2.doctor, 'POST', '/service/authorizations', {
          purseId: f.purseId,
          proformaLineIds: [lines[1]?.['id']],
        })
      ).status,
    ).toBe(201);
    // The new doctor's list has the patient; the old doctor's does not.
    await project('wallet.doctor_changed', { purseId: f.purseId, workplaceId: w2.workplaceId });
    const theirs = (await w.staff(w2.doctor, 'GET', '/service/patients')).body as unknown as Body[];
    expect(theirs.map((p) => p['purseId'])).toContain(f.purseId);
    const mine = (await w.staff(w.doctor, 'GET', '/service/patients')).body as unknown as Body[];
    expect(mine.map((p) => p['purseId'])).not.toContain(f.purseId);
    await ledgerSound();
  });

  it('a recorded service not yet final stops it (owner پ۹); the same doctor is no change', async () => {
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('service.finalize_after_hours', 'global', '24', now(), 'approved', 'آزمون', now())`,
    );
    try {
      const f = await fundedPurse();
      const creditManager = await w.role('credit_manager');
      const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
        'lines'
      ] as Body[];
      const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
        purseId: f.purseId,
        proformaLineIds: [lines[0]?.['id']],
      });
      const delivered = await w.staff(
        w.doctor,
        'POST',
        `/service/authorizations/${made.body['id'] as string}/deliver`,
        { code: lastCode(f.patient.mobile) },
      );
      expect(delivered.body['status']).toBe('delivered');
      const w3 = await creditWorld(h);
      const asked = await w.staff(w.completion, 'POST', '/wallet/special-operations', {
        kind: 'change_doctor',
        purseId: f.purseId,
        workplaceId: w3.workplaceId,
        reason: 'توقف درمان',
      });
      const refused = await approve(creditManager, asked.body['id'] as string);
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('service_not_final');
      expect((await wallet().summary(f.purseId)).balances.consumedPendingRial).toBe(6_000_000n);
      await w.staff(
        creditManager,
        'POST',
        `/wallet/special-operations/${asked.body['id'] as string}/reject`,
        {
          reason: 'خدمت ثبت‌شده باز است',
        },
      );
      const same = await w.staff(w.completion, 'POST', '/wallet/special-operations', {
        kind: 'change_doctor',
        purseId: f.purseId,
        workplaceId: w.workplaceId,
        reason: 'همان پزشک',
      });
      const refusedSame = await approve(creditManager, same.body['id'] as string);
      expect(refusedSame.status).toBe(409);
      expect(refusedSame.body['error']).toBe('same_doctor');
    } finally {
      await h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('service.finalize_after_hours', 'global', '0', now(), 'approved', 'آزمون', now())`,
      );
    }
  });
});

// --- part 4: a refund paid out cannot be taken back by a reversal (owner 1405/07/14) -------

describe('a cancellation whose down payment was refunded by bank (task 4-8, part 4)', () => {
  it('is not reversed: the refund account never goes below zero', async () => {
    const f = await fundedPurse();
    const asked = await ask(finance, {
      kind: 'cancel_unused',
      purseId: f.purseId,
      reason: 'انصراف بیمار از ادامه درمان',
    });
    const done = await approve(finance2, asked.body['id'] as string);
    expect(done.body['result']).toMatchObject({ downPaymentRial: DOWN.toString() });
    expect(await refundOf(f.purseId)).toBe(DOWN);

    // Part of it paid out by bank, by two people.
    const paid = await w.staff(finance, 'POST', '/refund-payments', {
      creditApplicationId: f.applicationId,
      account: 'down_payment',
      amountRial: '400000',
      bankReference: `PAID-${f.purseId.slice(0, 8)}`,
      paidOn: '2026-10-04',
      idempotencyKey: `paid-${f.purseId}`,
      reason: 'واریز به حساب وام‌گیرنده',
    });
    expect(paid.status).toBe(201);
    const posted = await w.staff(
      finance2,
      'POST',
      `/refund-payments/${paid.body['id'] as string}/approve`,
      {
        reason: 'با صورت‌حساب بانک تطبیق شد',
      },
    );
    expect(posted.status).toBe(201);
    expect(await refundOf(f.purseId)).toBe(DOWN - 400_000n);

    const reversal = await ask(finance, {
      kind: 'reverse_cancel_unused',
      requestId: asked.body['id'],
      reason: 'ابطال اشتباه بود',
    });
    const refused = await approve(finance2, reversal.body['id'] as string);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'refund_paid',
      owedRial: (DOWN - 400_000n).toString(),
    });
    expect(await refundOf(f.purseId)).toBe(DOWN - 400_000n);
    await ledgerSound();
  });
});

// --- part 7: cancelling after funding (doc 02 §6; owner 1405/07/14) -------------------------

/** Authorizes the first proforma line and enters the borrower's code: used, and final. */
async function useFirstLine(f: { purseId: string; patient: { mobile: string } }) {
  const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
    purseId: f.purseId,
    proformaLineIds: [lines[0]?.['id']],
  });
  expect(made.status).toBe(201);
  const delivered = await w.staff(
    w.doctor,
    'POST',
    `/service/authorizations/${made.body['id'] as string}/deliver`,
    { code: lastCode(f.patient.mobile) },
  );
  return { id: made.body['id'] as string, status: delivered.body['status'] as string };
}

async function chargesOf(scheduleId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT kind, amount_rial::text AS amount, due_on::text AS due_on, rate_bps
     FROM repayment_charges WHERE schedule_id = $1`,
    [scheduleId],
  );
  return rows;
}

describe('cancelling after funding (task 4-8, part 7; doc 02 §6)', () => {
  it('unused cancelled, the fee of installments not yet due waived, a lump-sum penalty, the purse closed', async () => {
    const f = await fundedPurse();
    await project('wallet.funded', { creditApplicationId: f.applicationId, purseId: f.purseId });
    const used = await useFirstLine(f);
    expect(used.status).toBe('finalized');
    const before = await wallet().summary(f.purseId);
    const consumed = before.balances.consumedPendingRial;

    const asked = await ask(finance, {
      kind: 'cancel_after_funding',
      purseId: f.purseId,
      reason: 'انصراف بیمار از ادامه درمان',
    });
    expect(asked.status).toBe(201);
    // Two people (doc 12 §7).
    expect((await approve(finance, asked.body['id'] as string)).body['error']).toBe('same_person');
    const done = await approve(finance2, asked.body['id'] as string);
    expect(done.status).toBe(201);
    const result = done.body['result'] as Body;

    // The down payment is used first (ADR-034): what is unused is the loan's.
    const usedLoan = consumed > DOWN ? consumed - DOWN : 0n;
    expect(result).toMatchObject({
      loanRial: (LOAN - usedLoan).toString(),
      downPaymentRial: (DOWN - (consumed < DOWN ? consumed : DOWN)).toString(),
      // Funded today: no installment is due yet, so the whole plan fee is waived (پ۱۱ الف).
      feeWaivedRial: FEE.toString(),
      // 18% of the approved loan (A), locked in the contract (س۴), due in 30 days.
      penaltyRial: ((LOAN * 1800n) / 10_000n).toString(),
      penaltyRateBps: 1800,
      closed: true,
    });

    // The purse closed, the schedule left with the loan used, the penalty on its own.
    const after = await wallet().summary(f.purseId);
    expect(after.status).toBe('closed');
    expect(after.balances.availableRial).toBe(0n);
    expect(after.balances.reservedRial).toBe(0n);
    const schedule = await repayment().schedule(f.scheduleId);
    expect(schedule.totalRial).toBe(usedLoan);
    expect(schedule.installments.every((i) => i.amountRial >= 0n)).toBe(true);
    const charges = await chargesOf(f.scheduleId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      kind: 'cancellation_penalty',
      amount: ((LOAN * 1800n) / 10_000n).toString(),
      due_on: result['penaltyDueOn'],
      rate_bps: 1800,
    });
    // The debt: the loan used and the penalty; the waived fee off it by a new document.
    expect(after.balances.borrowerDebtRial).toBe(usedLoan + (LOAN * 1800n) / 10_000n);
    const { rows: docs } = await h.owner.query<Row>(
      `SELECT event_type FROM journal_entries WHERE case_id = $1 AND event_type IN
         ('repayment.plan_fee', 'repayment.plan_fee_waived', 'repayment.cancellation_penalty')
       ORDER BY created_at`,
      [after.caseId],
    );
    expect(docs.map((d) => d['event_type'])).toEqual([
      'repayment.plan_fee',
      'repayment.plan_fee_waived',
      'repayment.cancellation_penalty',
    ]);

    // Approving again changes nothing: no second penalty, no second waiver.
    const again = await approve(finance2, asked.body['id'] as string);
    expect(again.body['result']).toEqual(result);
    expect(await chargesOf(f.scheduleId)).toHaveLength(1);

    // Closed: nothing new is authorized on it.
    const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
      'lines'
    ] as Body[] | undefined;
    const late = await w.staff(w.doctor, 'POST', '/service/authorizations', {
      purseId: f.purseId,
      proformaLineIds: [lines?.[1]?.['id'] ?? randomUUID()],
    });
    expect(late.status).toBeGreaterThanOrEqual(400);
    await ledgerSound();
  });

  it('a recorded service not yet final stops it whole (owner پ۹)', async () => {
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('service.finalize_after_hours', 'global', '24', now(), 'approved', 'آزمون', now())`,
    );
    try {
      const f = await fundedPurse();
      await project('wallet.funded', { creditApplicationId: f.applicationId, purseId: f.purseId });
      expect((await useFirstLine(f)).status).toBe('delivered');
      const before = await snapshot(f.purseId, f.scheduleId);
      const asked = await ask(finance, {
        kind: 'cancel_after_funding',
        purseId: f.purseId,
        reason: 'انصراف بیمار',
      });
      const refused = await approve(finance2, asked.body['id'] as string);
      expect(refused.status).toBe(409);
      expect(refused.body['error']).toBe('service_not_final');
      // Nothing of it happened.
      expect(await snapshot(f.purseId, f.scheduleId)).toEqual(before);
      expect(await chargesOf(f.scheduleId)).toHaveLength(0);
    } finally {
      await h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('service.finalize_after_hours', 'global', '0', now(), 'approved', 'آزمون', now())`,
      );
    }
  });

  it("the owner's example: 3 of 12 installments due, 240,000 of the fee kept and 720,000 waived", async () => {
    const f = await fundedPurse();
    const schedule = await repayment().schedule(f.scheduleId);
    const third = schedule.installments.find((i) => i.index === 3)?.dueOn ?? '';
    const actor = CLI_ACTOR;
    const waived = await repayment().waivePlanFee(actor, {
      scheduleId: f.scheduleId,
      today: third,
      idempotencyKey: `test-waive-${f.scheduleId}`,
      reason: 'آزمون بخشودن کارمزد',
    });
    expect(waived.waivedRial).toBe(720_000n);
    const after = await repayment().schedule(f.scheduleId);
    expect(after.totalRial).toBe(schedule.totalRial - 720_000n);
    // From the last installments back; none below zero; the due ones untouched.
    expect(after.installments.every((i) => i.amountRial >= 0n)).toBe(true);
    for (const i of after.installments.filter((x) => x.index <= 3)) {
      expect(i.amountRial).toBe(schedule.installments.find((x) => x.id === i.id)?.amountRial);
    }
    // The same key again: the same answer, nothing more.
    const replay = await repayment().waivePlanFee(actor, {
      scheduleId: f.scheduleId,
      today: third,
      idempotencyKey: `test-waive-${f.scheduleId}`,
      reason: 'آزمون بخشودن کارمزد',
    });
    expect(replay.waivedRial).toBe(720_000n);
    expect((await repayment().schedule(f.scheduleId)).totalRial).toBe(after.totalRial);

    // A penalty is never posted twice, whatever the key.
    const charge = (key: string) =>
      repayment().addCharge(actor, {
        scheduleId: f.scheduleId,
        kind: 'cancellation_penalty',
        amountRial: 1_000n,
        baseRial: LOAN,
        rateBps: 1800,
        dueOn: '2027-01-01',
        idempotencyKey: key,
        reason: 'آزمون خسارت',
      });
    await charge(`test-charge-a-${f.scheduleId}`);
    expect((await charge(`test-charge-a-${f.scheduleId}`)).replayed).toBe(true);
    await expect(charge(`test-charge-b-${f.scheduleId}`)).rejects.toMatchObject({
      response: { error: 'charge_exists' },
    });
    await ledgerSound();
  });

  it("a case's own rate (owner پ۱۳; ADR-044): accounting asks, the general manager approves, 0 to 18%, locked by the contract made after it", async () => {
    const creditManager = await w.role('credit_manager');
    const ceo = await w.role('ceo');
    const { patient, applicationId } = await steps.approved();
    const path = `/credit/applications/${applicationId}/penalty-overrides`;
    // ADR-044: the credit unit neither asks nor approves any more.
    const byCredit = await w.staff(w.creditSpecialist, 'POST', path, {
      penaltyBps: 1000,
      reason: 'وضعیت خاص بیمار',
    });
    expect(byCredit.status).toBe(403);
    expect(
      (await w.staff(creditManager, 'POST', path, { penaltyBps: 1000, reason: 'وضعیت خاص' }))
        .status,
    ).toBe(403);
    // Above 18%: refused.
    const high = await w.staff(finance, 'POST', path, {
      penaltyBps: 1900,
      reason: 'بیش از سقف',
    });
    expect(high.status).toBe(400);
    const asked = await w.staff(finance, 'POST', path, {
      penaltyBps: 1000,
      reason: 'وضعیت خاص بیمار',
    });
    expect(asked.status).toBe(201);
    // The general manager's queue holds it; the credit unit's has nothing to read.
    const queue = await w.staff(ceo, 'GET', '/credit/penalty-overrides');
    expect(queue.status).toBe(200);
    expect((queue.body as unknown as Row[]).map((r) => r['id'])).toContain(asked.body['id']);
    expect((await w.staff(creditManager, 'GET', '/credit/penalty-overrides')).status).toBe(403);
    // The service itself, behind the route's guard: a permission, and only reachable cases.
    const overrides = h.app.get(PenaltyOverrideService, { strict: false });
    const base = { accountId: randomUUID(), roles: [] };
    await expect(
      overrides.pending(CLI_ACTOR, {
        ...base,
        permissions: new Set(),
        scopes: [{ kind: 'global' }],
      }),
    ).rejects.toMatchObject({ response: { error: 'permission_required' } });
    const elsewhere = await overrides.pending(CLI_ACTOR, {
      ...base,
      permissions: new Set(['credit.approve_penalty_override'] as const),
      scopes: [{ kind: 'city', code: 'no_such_city' }],
    });
    expect(elsewhere.map((r) => r.id)).not.toContain(asked.body['id']);
    const decide = (who: Staff) =>
      w.staff(who, 'POST', `/credit/penalty-overrides/${asked.body['id'] as string}/approve`, {
        reason: 'بررسی شد',
      });
    expect((await decide(creditManager)).status).toBe(403);
    expect((await decide(finance)).status).toBe(403);
    expect((await decide(ceo)).body['status']).toBe('approved');
    // Decided: out of the queue.
    expect(
      ((await w.staff(ceo, 'GET', '/credit/penalty-overrides')).body as unknown as Row[]).map(
        (r) => r['id'],
      ),
    ).not.toContain(asked.body['id']);

    // The contract made now locks 10%.
    await steps.complete(patient, applicationId);
    const purseId = await steps.fund(applicationId);
    const { rows } = await h.owner.query<Row>(
      `SELECT penalty_bps, source FROM contract_penalty_terms WHERE credit_application_id = $1`,
      [applicationId],
    );
    expect(rows).toEqual([{ penalty_bps: 1000, source: 'override' }]);
    // A contract exists: no override is asked any more.
    const late = await w.staff(finance, 'POST', path, {
      penaltyBps: 500,
      reason: 'پس از قرارداد',
    });
    expect(late.body['error']).toBe('contract_exists');

    const op = await ask(finance, {
      kind: 'cancel_after_funding',
      purseId,
      reason: 'انصراف بیمار',
    });
    const done = await approve(finance2, op.body['id'] as string);
    expect(done.body['result']).toMatchObject({
      penaltyRial: ((LOAN * 1000n) / 10_000n).toString(),
      penaltyRateBps: 1000,
    });
    await ledgerSound();
  });
});

// --- f7: the «new doctor» picker (owner 1405/07/23, plan 2) --------------------------------

describe('the doctors a purse may move to (f7; plan 2): a read, nothing written', () => {
  /** Rows a read must not add to: what anything writes leaves one of these. */
  async function written() {
    const { rows } = await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM audit_events) AS audit,
              (SELECT count(*)::int FROM outbox_events) AS outbox,
              (SELECT count(*)::int FROM ledger_accounts) AS accounts,
              (SELECT count(*)::int FROM purse_operation_requests) AS requests`,
    );
    return rows[0];
  }
  const candidates = (who: Staff, purseId: string, q?: string) =>
    w.staff(
      who,
      'GET',
      `/wallet/purses/${purseId}/doctor-candidates${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`,
    );
  const ids = (body: unknown) => (body as Body[]).map((c) => c['workplaceId']);

  it('offers what a doctor change accepts, by name; refuses who may not ask or reach it', async () => {
    const f = await fundedPurse();
    const networkManager = await w.role('network_manager');
    await w.staff(networkManager, 'POST', '/catalog/fields', {
      code: 'eye',
      name: 'چشم‌پزشکی',
      reason: 'آزمون انتخابگر',
    });
    // Another center in Tehran, active, with two more doctors: one of the purse's field,
    // one of another field only.
    const other = await creditWorld(h);
    const doctorAt = async (name: string, fieldCode: string) => {
      const made = await other.staff(other.specialist, 'POST', '/catalog/doctors', {
        // Owner 1405/07/27: the registration form requires the contract term.
        contractTerm: { startsOn: '2026-10-01', months: 12 },
        name,
        medicalCouncilNumber: councilNumber(),
        treatmentFieldCodes: [fieldCode],
        workplace: { kind: 'branch', branchId: other.branchId },
        reason: 'آزمون انتخابگر',
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const detail = await other.staff(
        other.specialist,
        'GET',
        `/catalog/doctors/${made.body['id'] as string}`,
      );
      return (detail.body['workplaces'] as { id: string }[])[0]?.id ?? '';
    };
    const lone = await doctorAt('دکتر یگانه', 'dental');
    const eyeOnly = await doctorAt('دکتر یگانه چشم', 'eye');
    // A center suspended: its doctor is no candidate (changeDoctor: center_not_active).
    const suspended = await creditWorld(h);
    const done = await suspended.staff(
      suspended.specialist,
      'POST',
      `/catalog/centers/${suspended.centerId}/suspend`,
      { reason: 'تخلف' },
    );
    expect(done.body['status']).toBe('suspended');

    const before = await written();
    const all = await candidates(w.completion, f.purseId);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const list = all.body as unknown as Body[];
    // Fewer than the page: an absence below means excluded, not cut off.
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThan(20);
    expect(ids(list)).toContain(lone);
    expect(ids(list)).toContain(other.workplaceId);
    expect(ids(list)).not.toContain(w.workplaceId); // the purse's own doctor
    expect(ids(list)).not.toContain(eyeOnly); // another treatment field
    expect(ids(list)).not.toContain(suspended.workplaceId); // a suspended center
    // The doctor's name is treatment data (doc 04 §4): stripped for whoever may not see it.
    expect(list.find((c) => c['workplaceId'] === lone)).toEqual({
      workplaceId: lone,
      // Owner 1405/07/24: the center's name only, no branch, no code.
      centerName: 'کلینیک اعتبار',
    });
    // Nor do they find by it; by center, typed with Arabic ي and ك (rule 23), they do.
    expect(ids((await candidates(w.completion, f.purseId, 'یگانه')).body)).toEqual([]);
    expect(ids((await candidates(w.completion, f.purseId, 'كلينيك')).body)).toEqual(ids(list));

    // Who may see the doctor (access.view_treatment; a role made for this test) gets the
    // name, and finds by it, typed with Arabic ي and ك: the one doctor of that name and field.
    await h.owner.query(
      `INSERT INTO roles (code, name, is_system) VALUES ('test_doctor_picker', 'آزمون', false)`,
    );
    await h.owner.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       SELECT id, p FROM roles, unnest(ARRAY['wallet.request_doctor_change',
         'access.view_treatment']) AS p WHERE code = 'test_doctor_picker'`,
    );
    const picker = await w.role('test_doctor_picker');
    const named = await candidates(picker, f.purseId);
    expect(ids(named.body)).toEqual(ids(list));
    expect((named.body as unknown as Body[]).find((c) => c['workplaceId'] === lone)).toEqual({
      workplaceId: lone,
      doctorName: 'دکتر یگانه',
      centerName: 'کلینیک اعتبار',
    });
    const byName = await candidates(picker, f.purseId, 'دكتر يگانه');
    expect(byName.status).toBe(200);
    expect(ids(byName.body)).toEqual([lone]);
    const elsewhere = await w.role('case_completion', { kind: 'city', code: 'isfahan' });
    // A pick from the list is what a doctor change accepts: asked, then rejected here.
    const asked = await w.staff(w.completion, 'POST', '/wallet/special-operations', {
      kind: 'change_doctor',
      purseId: f.purseId,
      workplaceId: lone,
      reason: 'انتخاب از فهرست',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const creditManager = await w.role('credit_manager');
    expect(
      (
        await w.staff(
          creditManager,
          'POST',
          `/wallet/special-operations/${asked.body['id'] as string}/reject`,
          { reason: 'فقط آزمون انتخابگر' },
        )
      ).status,
    ).toBe(201);
    const afterAsk = await written();

    // Who may not ask a doctor change gets 403; a purse out of their cities, 404 (IDOR).
    expect((await candidates(finance, f.purseId)).status).toBe(403);
    const hidden = await candidates(elsewhere, f.purseId);
    expect(hidden.status).toBe(404);
    expect(hidden.body['error']).toBe('purse_not_found');
    expect((await candidates(w.completion, randomUUID())).status).toBe(404);

    // The reads wrote nothing: only the request and its rejection did.
    expect(await written()).toEqual(afterAsk);
    expect(afterAsk?.['requests']).toBe(Number(before?.['requests']) + 1);
    expect(afterAsk?.['accounts']).toBe(before?.['accounts']);
  });

  it('never answers with a doctor’s council number, national ID or any number of theirs (owner 1405/07/26)', async () => {
    const f = await fundedPurse();
    const other = await creditWorld(h);
    const council = councilNumber();
    const national = nationalId();
    const made = await other.staff(other.specialist, 'POST', '/catalog/doctors', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      name: 'دکتر یکتاسان',
      medicalCouncilNumber: council,
      nationalId: national,
      treatmentFieldCodes: ['dental'],
      workplace: { kind: 'branch', branchId: other.branchId },
      reason: 'آزمون انتخابگر',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const detail = await other.staff(
      other.specialist,
      'GET',
      `/catalog/doctors/${made.body['id'] as string}`,
    );
    const workplaceId = (detail.body['workplaces'] as { id: string }[])[0]?.id ?? '';

    await h.owner.query(
      `INSERT INTO roles (code, name, is_system) VALUES ('test_picker_numbers', 'آزمون', false)
       ON CONFLICT DO NOTHING`,
    );
    await h.owner.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       SELECT id, p FROM roles, unnest(ARRAY['wallet.request_doctor_change',
         'access.view_treatment']) AS p WHERE code = 'test_picker_numbers'
       ON CONFLICT DO NOTHING`,
    );
    const seesNames = await w.role('test_picker_numbers');
    for (const who of [w.completion, seesNames]) {
      for (const q of [undefined, 'یکتاسان', council, national, national.slice(-4)]) {
        const res = await candidates(who, f.purseId, q);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const rows = res.body as unknown as Body[];
        // Only these keys, ever: the response schema is strict as well.
        for (const row of rows) {
          for (const key of Object.keys(row)) {
            expect(['workplaceId', 'doctorName', 'centerName']).toContain(key);
          }
        }
        const wire = JSON.stringify(res.body);
        expect(wire).not.toContain(council);
        expect(wire).not.toContain(national);
        expect(wire).not.toMatch(/mobile|phone|national|council/i);
        // Nor does a number find a doctor: no search by council number or national ID.
        if (q === council || q === national || q === national.slice(-4)) {
          expect(ids(rows)).not.toContain(workplaceId);
        }
      }
    }
    // The doctor is offered at all, by name, to who may see names.
    expect(ids((await candidates(seesNames, f.purseId, 'یکتاسان')).body)).toEqual([workplaceId]);
  });
});

// --- ADR-045: a plan fee paid in cash, its unearned part owed back (owner 1405/07/27) -------

describe('cancelling after funding with the plan fee paid at completion (ADR-045)', () => {
  const AT_COMPLETION = {
    ...PLAN,
    code: 'dental_12_ac_refund',
    title: 'طرح دندانپزشکی، کارمزد هنگام تکمیل',
    planFee: { basis: 'percent', bps: 1000, timing: 'at_completion' },
  } as const;

  it('its unearned part to fee.refund_payable on its own document; the penalty on its own, never netted', async () => {
    const [a, b] = [await w.role('strategy_manager'), await w.role('strategy_manager')];
    const proposal = await w.staff(a, 'POST', '/config/proposals', {
      key: 'credit.plans',
      scope: { level: 'global' },
      value: { plans: [PLAN, AT_COMPLETION] },
      reason: 'طرح با کارمزد هنگام تکمیل (ADR-045)',
    });
    expect(
      (await w.staff(b, 'POST', `/config/proposals/${proposal.body['id'] as string}/approve`))
        .status,
    ).toBe(200);
    const { patient, applicationId } = await steps.approved(AT_COMPLETION.code);
    await steps.complete(patient, applicationId);
    const purseId = await steps.fund(applicationId);
    const { rows: receipts } = await h.owner.query<Row>(
      `SELECT id, amount_rial::text AS amount FROM completion_receipts
        WHERE credit_application_id = $1 AND kind = 'plan_fee' AND status = 'approved'`,
      [applicationId],
    );
    expect(receipts).toHaveLength(1);
    const fee = BigInt(receipts[0]?.['amount'] as string);
    expect(fee).toBeGreaterThan(0n);
    const before = await wallet().summary(purseId);
    const penalty = (before.approvedAmountRial * 1800n) / 10_000n;

    const asked = await ask(finance, { kind: 'cancel_after_funding', purseId, reason: 'انصراف' });
    expect(asked.status).toBe(201);
    const done = await approve(finance2, asked.body['id'] as string);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const result = done.body['result'] as Body;
    // Funded today: no installment is due, so all of the cash fee is unearned; no spread fee.
    expect(result).toMatchObject({
      planFeeRefundRial: fee.toString(),
      feeWaivedRial: '0',
      penaltyRial: penalty.toString(),
      closed: true,
    });

    // Two documents: the refund (Dr fee income, Cr the borrower's refund payable) and the
    // penalty (Dr the debt, Cr fee income), each balanced, neither netted with the other.
    const lines = async (eventType: string) =>
      (
        await h.owner.query<Row>(
          `SELECT a.code, e.direction, e.amount_rial::text AS amount
             FROM journal_entries j JOIN ledger_entries e ON e.journal_entry_id = j.id
             JOIN ledger_accounts a ON a.id = e.account_id
            WHERE j.case_id = $1 AND j.event_type = $2 ORDER BY e.direction`,
          [before.caseId, eventType],
        )
      ).rows;
    expect(await lines('contract.plan_fee_refunded')).toEqual([
      { code: 'fee.refund_payable', direction: 'credit', amount: fee.toString() },
      { code: 'company.fee_income', direction: 'debit', amount: fee.toString() },
    ]);
    expect(await lines('repayment.cancellation_penalty')).toEqual([
      { code: 'company.fee_income', direction: 'credit', amount: penalty.toString() },
      { code: 'borrower.debt', direction: 'debit', amount: penalty.toString() },
    ]);
    const after = await wallet().summary(purseId);
    // The debt keeps the whole penalty: the refund owed is not taken off it.
    expect(after.balances.borrowerDebtRial).toBe(penalty);
    const { rows: refunds } = await h.owner.query<Row>(
      `SELECT receipt_id, kind, amount_rial::text AS amount, cancellation_id FROM completion_refunds
        WHERE credit_application_id = $1`,
      [applicationId],
    );
    expect(refunds).toEqual([
      {
        receipt_id: receipts[0]?.['id'],
        kind: 'plan_fee',
        amount: fee.toString(),
        cancellation_id: asked.body['id'],
      },
    ]);

    // Once: approving again returns the same, no second document or row.
    const again = await approve(finance2, asked.body['id'] as string);
    expect(again.body['result']).toEqual(result);
    expect(await lines('contract.plan_fee_refunded')).toHaveLength(2);
    expect(
      (
        await h.owner.query<Row>(
          'SELECT count(*)::int AS n FROM completion_refunds WHERE credit_application_id = $1',
          [applicationId],
        )
      ).rows[0]?.['n'],
    ).toBe(1);

    // Append-only (doc 02 §1-3): the application role cannot change or remove its lines.
    const app = h.app.get<Database>(DATABASE);
    const refusal = async (p: Promise<unknown>) =>
      p.then(
        () => 'accepted',
        (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e),
      );
    const journal = result['planFeeRefundJournalId'] as string;
    expect(
      await refusal(
        app.execute(
          sql`UPDATE ledger_entries SET amount_rial = 1 WHERE journal_entry_id = ${journal}`,
        ),
      ),
    ).toContain('permission denied');
    expect(
      await refusal(
        app.execute(sql`DELETE FROM ledger_entries WHERE journal_entry_id = ${journal}`),
      ),
    ).toContain('permission denied');
    // Every document balanced; the nightly reconciliations clean, refunds included (doc 02 §7).
    await ledgerSound();
  });

  it('on a later day only the shares not yet due: the port itself, once per receipt', async () => {
    const { patient, applicationId } = await steps.approved(AT_COMPLETION.code);
    await steps.complete(patient, applicationId);
    const purseId = await steps.fund(applicationId);
    const summary = await wallet().summary(purseId);
    const { rows } = await h.owner.query<Row>(
      `SELECT schedule_id FROM funding_requests WHERE purse_id = $1`,
      [purseId],
    );
    const schedule = await repayment().schedule(rows[0]?.['schedule_id'] as string);
    const installments = schedule.installments.map((i) => ({ index: i.index, dueOn: i.dueOn }));
    const { rows: receipts } = await h.owner.query<Row>(
      `SELECT amount_rial::text AS amount FROM completion_receipts
        WHERE credit_application_id = $1 AND kind = 'plan_fee' AND status = 'approved'`,
      [applicationId],
    );
    const fee = BigInt(receipts[0]?.['amount'] as string);
    // Cancelled on the third installment's due day: three earned, the rest owed back.
    const today = installments[2]?.dueOn ?? '';
    const shares = planFeeShares(fee, installments.length);
    const expected = fee - (shares[0] ?? 0n) - (shares[1] ?? 0n) - (shares[2] ?? 0n);
    expect(expected).toBeLessThan(fee);
    const refunds = h.app.get<CompletionRefundsPort>(COMPLETION_REFUNDS, { strict: false });
    const db = h.app.get<Database>(DATABASE);
    const operationId = randomUUID();
    const first = await db.transaction((tx) =>
      refunds.refundUnearnedPlanFee(
        CLI_ACTOR,
        { creditApplicationId: applicationId, operationId, today, installments },
        tx,
      ),
    );
    expect(first).toMatchObject({ kind: 'plan_fee', amountRial: expected.toString() });
    const again = await db.transaction((tx) =>
      refunds.refundUnearnedPlanFee(
        CLI_ACTOR,
        { creditApplicationId: applicationId, operationId, today: '2020-01-01', installments },
        tx,
      ),
    );
    expect(again).toEqual(first);
    // After the last installment, nothing; never a row of 0.
    const { patient: p2, applicationId: a2 } = await steps.approved(AT_COMPLETION.code);
    await steps.complete(p2, a2);
    await steps.fund(a2);
    const none = await db.transaction((tx) =>
      refunds.refundUnearnedPlanFee(
        CLI_ACTOR,
        { creditApplicationId: a2, operationId: randomUUID(), today: '2099-01-01', installments },
        tx,
      ),
    );
    expect(none).toBeNull();
    expect(summary.status).toBe('funded');
    await ledgerSound();
  });
});
