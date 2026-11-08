import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { payableDue } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { LEDGER, type LedgerPort } from '../../src/common/ledger/ledger.port';
import { WALLET, type WalletPort } from '../../src/common/wallet/wallet.port';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { SettlementReconciliation } from '../../src/modules/settlement/settlement-reconciliation';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
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
 * Task 5-1 [financial] (doc 06 §1, §3, §8; doc 14 الف, ب; owner 1405/07/14, CLAUDE.md §4): each
 * final service becomes the doctor's payable and its fee, once. Rates and the cycle are
 * configuration (0 at first), resolved doctor → center → treatment field → global at the
 * moment the service became final and locked on the records; a change moves only later ones.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;
const texts = new CapturingTextSender();

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
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

const settlement = () => h.app.get(SettlementService);
const ledger = () => h.app.get<LedgerPort>(LEDGER);
const wallet = () => h.app.get<WalletPort>(WALLET);

/** A configuration value in force from now on, as two people would have approved it. */
async function setRate(
  key: string,
  value: unknown,
  scope: { level: 'global' | 'treatment_field' | 'center' | 'doctor'; ref?: string } = {
    level: 'global',
  },
) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, scope_ref, value, effective_at, status, reason, decided_at)
     VALUES ($1, $2, $3, $4, now(), 'approved', 'آزمون', now())`,
    [key, scope.level, scope.ref ?? null, JSON.stringify(value)],
  );
}

async function fundedPurse() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  return { patient, applicationId, purseId };
}

const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

/** One proforma line authorized and its code entered: final at once (no dispute window). */
async function finalService(f: { purseId: string; patient: { mobile: string } }, line: number) {
  const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${f.purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
    purseId: f.purseId,
    proformaLineIds: [lines[line]?.['id']],
  });
  expect(made.status).toBe(201);
  const done = await w.staff(
    w.doctor,
    'POST',
    `/service/authorizations/${made.body['id'] as string}/deliver`,
    { code: lastCode(f.patient.mobile) },
  );
  expect(done.body['status']).toBe('finalized');
  const { rows } = await h.owner.query<Row>(
    `SELECT id, amount_rial::text AS amount, doctor_node_id, center_node_id, finalized_at
     FROM service_authorizations WHERE id = $1`,
    [made.body['id']],
  );
  const r = rows[0] as Row;
  return {
    id: r['id'] as string,
    amount: BigInt(r['amount'] as string),
    doctorNodeId: r['doctor_node_id'] as string,
    centerNodeId: r['center_node_id'] as string,
    finalizedAt: r['finalized_at'] as Date,
  };
}

async function recordsOf(authorizationId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT p.id, p.status, p.amount_rial::text AS amount, p.contract_cycle_months AS months,
            p.due_at, f.basis, f.rate_value, f.amount_rial::text AS fee, f.journal_entry_id AS fee_journal,
            f.status AS fee_status
     FROM doctor_payables p JOIN service_fees f ON f.doctor_payable_id = p.id
     WHERE p.service_delivery_id = $1`,
    [authorizationId],
  );
  return rows;
}

async function balanceOf(code: string, doctorNodeId: string) {
  const account = await ledger().findAccount({
    entityId: 'aramesh',
    code,
    ownerType: 'doctor',
    ownerId: doctorNodeId,
  });
  if (!account) return 0n;
  const b = await ledger().balanceOf(account.id);
  return code === 'doctor.payable' ? b.creditRial - b.debitRial : b.debitRial - b.creditRial;
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

describe("a doctor's payable and the credit service's fee (task 5-1)", () => {
  it('at 0 (the first value): the payable made, a fee of 0 locked on it, nothing posted for it', async () => {
    const f = await fundedPurse();
    const s = await finalService(f, 0);
    const before = await balanceOf('doctor.payable', s.doctorNodeId);
    const made = await settlement().accrue(CLI_ACTOR, s.id);
    expect(made.created).toBe(true);
    const rows = await recordsOf(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'accrued',
      amount: s.amount.toString(),
      months: 1,
      basis: 'percent',
      rate_value: '0',
      fee: '0',
      fee_journal: null,
    });
    // Monthly by default: due one Jalali month after the day it became final.
    expect(rows[0]?.['due_at']).toEqual(payableDue(s.finalizedAt, 1).dueAt);
    // Moved on the purse to the doctor: consumed_pending → doctor.payable.
    expect(await balanceOf('doctor.payable', s.doctorNodeId)).toBe(before + s.amount);
    expect((await wallet().summary(f.purseId)).balances.consumedPendingRial).toBe(0n);
    await sound();
  });

  it('a percent, then a fixed amount at the doctor: each posted, each locked; a change moves only later services', async () => {
    const f = await fundedPurse();
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 1000 });
    const first = await finalService(f, 0);
    await settlement().accrue(CLI_ACTOR, first.id);
    const fee1 = (first.amount * 1000n) / 10_000n;
    expect((await recordsOf(first.id))[0]).toMatchObject({
      basis: 'percent',
      rate_value: '1000',
      fee: fee1.toString(),
    });
    expect((await recordsOf(first.id))[0]?.['fee_journal']).not.toBeNull();

    // Changed at the doctor's level: the first service keeps 10%; the next takes the new one.
    await setRate(
      'settlement.credit_service_fee',
      { basis: 'fixed', rial: '150000' },
      { level: 'doctor', ref: first.doctorNodeId },
    );
    expect((await recordsOf(first.id))[0]).toMatchObject({
      rate_value: '1000',
      fee: fee1.toString(),
    });
    const second = await finalService(f, 1);
    await settlement().accrue(CLI_ACTOR, second.id);
    expect((await recordsOf(second.id))[0]).toMatchObject({
      basis: 'fixed',
      rate_value: '150000',
      fee: '150000',
    });
    // Back to the first value: the global 0, and the doctor's level withdrawn (null).
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 0 });
    await setRate('settlement.credit_service_fee', null, {
      level: 'doctor',
      ref: first.doctorNodeId,
    });
    await sound();
  });

  it('the levels, most specific first: doctor → center → treatment field → global', async () => {
    const f = await fundedPurse();
    const probe = await finalService(f, 0);
    await settlement().accrue(CLI_ACTOR, probe.id);
    const fee = (bps: number, amount: bigint) => ((amount * BigInt(bps)) / 10_000n).toString();

    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 100 });
    await setRate(
      'settlement.credit_service_fee',
      { basis: 'percent', bps: 200 },
      { level: 'treatment_field', ref: 'dental' },
    );
    const g = await fundedPurse();
    const byField = await finalService(g, 0);
    await settlement().accrue(CLI_ACTOR, byField.id);
    expect((await recordsOf(byField.id))[0]).toMatchObject({
      rate_value: '200',
      fee: fee(200, byField.amount),
    });

    await setRate(
      'settlement.credit_service_fee',
      { basis: 'percent', bps: 300 },
      { level: 'center', ref: byField.centerNodeId },
    );
    const byCenter = await finalService(g, 1);
    await settlement().accrue(CLI_ACTOR, byCenter.id);
    expect((await recordsOf(byCenter.id))[0]).toMatchObject({
      rate_value: '300',
      fee: fee(300, byCenter.amount),
    });

    await setRate(
      'settlement.credit_service_fee',
      { basis: 'percent', bps: 400 },
      { level: 'doctor', ref: byField.doctorNodeId },
    );
    const h2 = await fundedPurse();
    const byDoctor = await finalService(h2, 0);
    await settlement().accrue(CLI_ACTOR, byDoctor.id);
    expect((await recordsOf(byDoctor.id))[0]).toMatchObject({
      rate_value: '400',
      fee: fee(400, byDoctor.amount),
    });
    // Each earlier one kept its own (locked).
    expect((await recordsOf(probe.id))[0]).toMatchObject({ rate_value: '0' });
    expect((await recordsOf(byField.id))[0]).toMatchObject({ rate_value: '200' });

    // Back to the first value: the global 0, and each level it set withdrawn (null).
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 0 });
    for (const [level, ref] of [
      ['treatment_field', 'dental'],
      ['center', byField.centerNodeId],
      ['doctor', byField.doctorNodeId],
    ] as const) {
      await setRate('settlement.credit_service_fee', null, { level, ref });
    }
    await sound();
  });

  it('once: delivered twice, at once, and by the backfill; the purse finalized once', async () => {
    const f = await fundedPurse();
    const s = await finalService(f, 0);
    const results = await Promise.all([
      settlement().accrue(CLI_ACTOR, s.id),
      settlement().accrue(CLI_ACTOR, s.id),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.payableId)).size).toBe(1);
    expect((await settlement().accrue(CLI_ACTOR, s.id)).created).toBe(false);
    const again = await settlement().backfill(CLI_ACTOR);
    expect(again.failed).toBe(0);
    expect(await recordsOf(s.id)).toHaveLength(1);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM purse_operations WHERE authorization_id = $1 AND kind = 'finalize'`,
      [s.id],
    );
    expect(rows[0]?.['n']).toBe(1);
    await sound();
  });

  it('the backfill takes a service final before it; the cycle at the doctor locks a 3-month due day', async () => {
    const f = await fundedPurse();
    const s = await finalService(f, 0);
    await setRate('settlement.contract_cycle_months', 3, { level: 'doctor', ref: s.doctorNodeId });
    // Final before the change: the cycle in force then (1 month) is the one locked.
    const made = await settlement().backfill(CLI_ACTOR);
    expect(made.made).toBeGreaterThanOrEqual(1);
    expect((await recordsOf(s.id))[0]).toMatchObject({ months: 1 });
    // A service after it: 3 months (doc 06 §8 test 1).
    const later = await finalService(f, 1);
    await settlement().accrue(CLI_ACTOR, later.id);
    const rows = await recordsOf(later.id);
    expect(rows[0]).toMatchObject({ months: 3 });
    expect(rows[0]?.['due_at']).toEqual(payableDue(later.finalizedAt, 3).dueAt);
    await setRate('settlement.contract_cycle_months', null, {
      level: 'doctor',
      ref: s.doctorNodeId,
    });
  });

  it('accrued → due at its due moment, not before', async () => {
    const f = await fundedPurse();
    const s = await finalService(f, 0);
    await settlement().accrue(CLI_ACTOR, s.id);
    const due = (await recordsOf(s.id))[0]?.['due_at'] as Date;
    await settlement().markDue(new Date(due.getTime() - 1));
    expect((await recordsOf(s.id))[0]).toMatchObject({ status: 'accrued', fee_status: 'accrued' });
    const moved = await settlement().markDue(due);
    expect(moved.payables).toBeGreaterThanOrEqual(1);
    expect((await recordsOf(s.id))[0]).toMatchObject({ status: 'due', fee_status: 'due' });
    // Only forward: the database refuses anything else (rule 8).
    await expect(
      h.owner.query(
        `UPDATE doctor_payables SET status = 'accrued' WHERE service_delivery_id = $1`,
        [s.id],
      ),
    ).rejects.toThrow();
    await expect(
      h.owner.query(`UPDATE doctor_payables SET amount_rial = 1 WHERE service_delivery_id = $1`, [
        s.id,
      ]),
    ).rejects.toThrow();
  });

  it('a purse closed by a cancellation after funding still finalizes its used service', async () => {
    await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 500 });
    try {
      const f = await fundedPurse();
      const s = await finalService(f, 0);
      const finance2 = await w.role('accounting');
      const asked = await w.staff(finance, 'POST', '/wallet/special-operations', {
        kind: 'cancel_after_funding',
        purseId: f.purseId,
        reason: 'انصراف بیمار',
      });
      const done = await w.staff(
        finance2,
        'POST',
        `/wallet/special-operations/${asked.body['id'] as string}/approve`,
        { reason: 'تأیید' },
      );
      expect(done.status).toBe(201);
      expect((await wallet().summary(f.purseId)).status).toBe('closed');
      const made = await settlement().accrue(CLI_ACTOR, s.id);
      expect(made.created).toBe(true);
      expect((await recordsOf(s.id))[0]).toMatchObject({
        fee: ((s.amount * 500n) / 10_000n).toString(),
      });
      await sound();
    } finally {
      await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 0 });
    }
  });

  it('a rate is changed by two people only, and never to a negative or out-of-range value', async () => {
    const strategyA = await w.role('strategy_manager');
    const strategyB = await w.role('strategy_manager');
    const propose = (value: unknown) =>
      w.staff(strategyA, 'POST', '/config/proposals', {
        key: 'settlement.credit_service_fee',
        scope: { level: 'global' },
        value,
        reason: 'نرخ تازه',
      });
    for (const bad of [
      { basis: 'percent', bps: -1 },
      { basis: 'percent', bps: 10_001 },
      { basis: 'fixed', rial: '-5' },
      { basis: 'other', bps: 1 },
    ]) {
      expect((await propose(bad)).status).toBe(400);
    }
    const asked = await propose({ basis: 'percent', bps: 250 });
    expect(asked.status).toBe(201);
    const id = asked.body['id'] as string;
    expect(
      (await w.staff(strategyA, 'POST', `/config/proposals/${id}/approve`)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await w.staff(strategyB, 'POST', `/config/proposals/${id}/reject`, { reason: 'آزمون' }))
        .status,
    ).toBeLessThan(300);
    // The database never holds a negative fee.
    await expect(
      h.owner.query(
        `INSERT INTO service_fees (kind, doctor_payable_id, doctor_id, doctor_node_id, entity_id, basis,
           rate_value, config_version_id, amount_rial, due_at)
         SELECT 'credit', id, doctor_id, doctor_node_id, entity_id, 'percent', '0', cycle_config_version_id, -1, due_at
         FROM doctor_payables LIMIT 1`,
      ),
    ).rejects.toThrow();
  });
});
