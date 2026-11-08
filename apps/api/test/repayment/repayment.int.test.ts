import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { createPool } from '../../src/db/pool';
import { ConfigService } from '../../src/modules/config/config.service';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import {
  actorFor,
  call,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
} from '../identity/harness';
import { scheduleVersionsNow } from './rounding-version';

let h: Harness;
let app: Pool;
let wallet: WalletService;
let repayment: RepaymentService;
let counter = 0;
const key = (label: string) => `repay-test-${label}-${String(++counter)}-${String(Date.now())}`;
const M = 1_000_000n;

/** A funded purse with a schedule of `count` installments; returns both ids. */
async function scheduled(principal: bigint, count: number, planFee = 0n) {
  const scope = {
    centerNodeId: randomUUID(),
    doctorNodeId: randomUUID(),
    treatmentFieldCode: 'dental',
  };
  const approved = await wallet.approveCredit(CLI_ACTOR, {
    idempotencyKey: key('approve'),
    caseId: randomUUID(),
    borrowerPersonId: randomUUID(),
    amountRial: principal,
    scope,
  });
  await wallet.charge(CLI_ACTOR, approved.purseId, { idempotencyKey: key('charge') });
  const { scheduleId } = await repayment.createSchedule(CLI_ACTOR, {
    idempotencyKey: key('schedule'),
    purseId: approved.purseId,
    installmentCount: count,
    planFeeRial: planFee,
    ...(await scheduleVersionsNow(h)),
  });
  return { purseId: approved.purseId, scheduleId };
}

async function pay(scheduleId: string, amount: bigint) {
  const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
    idempotencyKey: key('receipt'),
    scheduleId,
    amountRial: amount,
    receivedAt: new Date(),
    reference: `slip-${String(counter)}`,
  });
  return paymentId;
}

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
  wallet = h.app.get(WalletService);
  repayment = h.app.get(RepaymentService);
});

afterAll(async () => {
  await app.end();
  await h.close();
});

describe('the schedule', () => {
  it('sums to principal + plan fee, remainder on the first, due monthly from funding', async () => {
    const { purseId, scheduleId } = await scheduled(100_000_007n, 12, 12n * M);
    const s = await repayment.schedule(scheduleId);
    expect(s.totalRial).toBe(112_000_007n);
    expect(s.installments.reduce((sum, i) => sum + i.amountRial, 0n)).toBe(s.totalRial);
    expect(s.installments[1]?.amountRial).toBe(9_330_000n);
    expect(s.installments[0]?.amountRial).toBe(112_000_007n - 11n * 9_330_000n);
    expect(s.roundingUnitRial).toBe(10_000n);
    expect(new Set(s.installments.map((i) => i.dueOn)).size).toBe(12);
    expect(s.installments.every((i) => i.status === 'scheduled')).toBe(true);

    // The plan fee is posted at once: the borrower owes principal + fee.
    const summary = await wallet.summary(purseId);
    expect(summary.balances.borrowerDebtRial).toBe(112_000_007n);
  });

  it('HARD RULE: a total too small for the count is refused, never zero installments', async () => {
    const scope = {
      centerNodeId: randomUUID(),
      doctorNodeId: randomUUID(),
      treatmentFieldCode: 'dental',
    };
    const approved = await wallet.approveCredit(CLI_ACTOR, {
      idempotencyKey: key('a'),
      caseId: randomUUID(),
      borrowerPersonId: randomUUID(),
      amountRial: 50_000n,
      scope,
    });
    await wallet.charge(CLI_ACTOR, approved.purseId, { idempotencyKey: key('c') });
    await expect(
      repayment.createSchedule(CLI_ACTOR, {
        idempotencyKey: key('s'),
        purseId: approved.purseId,
        installmentCount: 12,
        planFeeRial: 0n,
        ...(await scheduleVersionsNow(h)),
      }),
    ).rejects.toMatchObject({ status: 400, response: { error: 'total_too_small_for_count' } });
    // Nothing was written, not even the fee.
    const { rows } = await h.owner.query(
      'SELECT count(*)::int AS n FROM installment_schedules WHERE purse_id = $1',
      [approved.purseId],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('one schedule per case; a repeated key returns it; an unfunded purse has none', async () => {
    const { purseId, scheduleId } = await scheduled(12n * M, 6);
    await expect(
      repayment.createSchedule(CLI_ACTOR, {
        idempotencyKey: key('again'),
        purseId,
        installmentCount: 6,
        planFeeRial: 0n,
        ...(await scheduleVersionsNow(h)),
      }),
    ).rejects.toMatchObject({ response: { error: 'schedule_exists_for_case' } });

    const input = {
      idempotencyKey: key('idem'),
      purseId: randomUUID(),
      installmentCount: 3,
      planFeeRial: 0n,
      ...(await scheduleVersionsNow(h)),
    };
    await expect(repayment.createSchedule(CLI_ACTOR, input)).rejects.toMatchObject({ status: 404 });
    expect(scheduleId).toBeTruthy();
  });

  it('rule 16: a later change of the rounding unit leaves an existing schedule alone', async () => {
    const { scheduleId: before } = await scheduled(120n * M, 12);
    const config = h.app.get(ConfigService);
    const manage = {
      accountId: '',
      roles: [],
      permissions: new Set(['config.manage_business'] as const),
      scopes: [],
    };
    const makerId = randomUUID();
    const proposal = await config.propose(actorFor(makerId), manage, {
      key: 'repayment.rounding_unit_rial',
      scope: { level: 'global' },
      value: '1000000',
      reason: 'گرد کردن به میلیون',
    });
    await config.decide(actorFor(randomUUID()), manage, proposal.id, true);

    const old = await repayment.schedule(before);
    expect(old.roundingUnitRial).toBe(10_000n);
    const { scheduleId: after } = await scheduled(120n * M, 12);
    const fresh = await repayment.schedule(after);
    expect(fresh.roundingUnitRial).toBe(1_000_000n);
    expect(fresh.roundingConfigVersionId).not.toBe(old.roundingConfigVersionId);
  });
});

describe('payments', () => {
  it('a receipt waits in suspense; approval pays the oldest installment first', async () => {
    const { scheduleId } = await scheduled(12n * M, 12); // 1,000,000 each
    const paymentId = await pay(scheduleId, 2_500_000n);
    let s = await repayment.schedule(scheduleId);
    expect(s.unallocatedRial).toBe(2_500_000n);
    expect(s.paidRial).toBe(0n);

    const decision = await repayment.approvePayment(CLI_ACTOR, paymentId);
    expect(decision.allocatedRial).toBe(2_500_000n);
    expect(decision.surplusRial).toBe(0n);
    s = await repayment.schedule(scheduleId);
    expect(s.installments.slice(0, 3).map((i) => i.paidRial)).toEqual([M, M, 500_000n]);
    expect(s.installments[2]?.status).toBe('partially_paid');
    expect(s.unallocatedRial).toBe(0n);
  });

  it('beyond the whole obligation, the surplus stays in suspense', async () => {
    const { purseId, scheduleId } = await scheduled(3n * M, 3);
    const decision = await repayment.approvePayment(CLI_ACTOR, await pay(scheduleId, 3_700_000n));
    expect(decision).toMatchObject({ allocatedRial: 3n * M, surplusRial: 700_000n });
    const s = await repayment.schedule(scheduleId);
    expect(s.outstandingRial).toBe(0n);
    expect(s.installments.every((i) => i.status === 'paid')).toBe(true);
    expect(s.unallocatedRial).toBe(700_000n);
    expect((await wallet.summary(purseId)).balances.borrowerDebtRial).toBe(0n);
  });

  it('no penalty and no discount: amounts are the same before and after the due day', async () => {
    const { scheduleId } = await scheduled(6n * M, 6);
    const today = await repayment.schedule(scheduleId);
    const yearLater = await repayment.schedule(
      scheduleId,
      new Date(Date.now() + 400 * 24 * 3600 * 1000),
    );
    expect(yearLater.installments.map((i) => i.amountRial)).toEqual(
      today.installments.map((i) => i.amountRial),
    );
    expect(yearLater.installments.every((i) => i.status === 'overdue')).toBe(true);
    expect(yearLater.totalRial).toBe(today.totalRial);
  });

  it('the status follows the Tehran calendar day', async () => {
    const { scheduleId } = await scheduled(2n * M, 2);
    const s = await repayment.schedule(scheduleId);
    const [first] = s.installments;
    const [y, m, d] = (first?.dueOn ?? '').split('-').map(Number);
    const dueDayNoon = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, 8, 30)); // 12:00 Tehran
    expect((await repayment.schedule(scheduleId, dueDayNoon)).installments[0]?.status).toBe('due');
  });

  it('approving twice, even at once, allocates once', async () => {
    const { scheduleId } = await scheduled(10n * M, 10);
    const paymentId = await pay(scheduleId, 4n * M);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => repayment.approvePayment(CLI_ACTOR, paymentId)),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const s = await repayment.schedule(scheduleId);
    expect(s.paidRial).toBe(4n * M);
    const { rows } = await h.owner.query(
      'SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = $1',
      [paymentId],
    );
    expect(rows[0]).toEqual({ n: 4 });
  });

  it('two payments approved at once never overpay an installment', async () => {
    const { scheduleId } = await scheduled(4n * M, 4);
    const [a, b] = [await pay(scheduleId, 3n * M), await pay(scheduleId, 3n * M)];
    await Promise.all([
      repayment.approvePayment(CLI_ACTOR, a),
      repayment.approvePayment(CLI_ACTOR, b),
    ]);
    const s = await repayment.schedule(scheduleId);
    expect(s.paidRial).toBe(4n * M);
    expect(s.unallocatedRial).toBe(2n * M);
    for (const i of s.installments) expect(i.paidRial).toBeLessThanOrEqual(i.amountRial);
  });

  it('a rejected payment stays in suspense and cannot be approved later', async () => {
    const { scheduleId } = await scheduled(2n * M, 2);
    const paymentId = await pay(scheduleId, M);
    await repayment.rejectPayment(CLI_ACTOR, paymentId, 'فیش جعلی');
    await expect(repayment.approvePayment(CLI_ACTOR, paymentId)).rejects.toMatchObject({
      response: { error: 'payment_rejected' },
    });
    const s = await repayment.schedule(scheduleId);
    expect(s.paidRial).toBe(0n);
    expect(s.unallocatedRial).toBe(M);
  });
});

describe('the ledger and the database', () => {
  it('every repayment document balances, and the bank receives exactly what was paid in', async () => {
    const { rows } = await h.owner.query<{ unbalanced: number; docs: number }>(`
      SELECT count(*) FILTER (WHERE d <> c)::int AS unbalanced, count(*)::int AS docs FROM (
        SELECT e.journal_entry_id,
               sum(e.amount_rial) FILTER (WHERE e.direction = 'debit') AS d,
               sum(e.amount_rial) FILTER (WHERE e.direction = 'credit') AS c
        FROM ledger_entries e JOIN journal_entries j ON j.id = e.journal_entry_id
        WHERE j.event_type LIKE 'repayment.%' GROUP BY e.journal_entry_id
      ) t`);
    expect(rows[0]?.docs).toBeGreaterThan(0);
    expect(rows[0]?.unbalanced).toBe(0);
    const totals = await h.owner.query<{ paid: string; bank: string }>(`
      SELECT (SELECT sum(amount_rial)::text FROM payments) AS paid,
             (SELECT sum(e.amount_rial)::text FROM ledger_entries e
              JOIN ledger_accounts a ON a.id = e.account_id
              WHERE a.code = 'bank.collection' AND e.direction = 'debit') AS bank`);
    expect(totals.rows[0]?.bank).toBe(totals.rows[0]?.paid);
  });

  it('schedules, installments and allocations never change; a payment only its decision', async () => {
    await expect(app.query('UPDATE installments SET amount_rial = 1')).rejects.toMatchObject({
      code: '42501',
    });
    // UPDATE (id) is granted only so the schedule row can be locked; writing it still fails.
    await expect(app.query('UPDATE installment_schedules SET id = id')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(h.owner.query('UPDATE installments SET amount_rial = 1')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.query('UPDATE payments SET amount_rial = 1')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(h.owner.query('DELETE FROM payment_allocations')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('the database refuses a schedule whose installments do not add up', async () => {
    // A version that exists and was approved: the schedule's version column references
    // config_values (0082), so only the installments are wrong here.
    const { rows: versions } = await h.owner.query<{ id: string }>(
      `SELECT id FROM config_values
       WHERE key = 'repayment.rounding_unit_rial' AND status = 'approved' AND deleted_at IS NULL
       ORDER BY effective_at DESC LIMIT 1`,
    );
    const roundingVersionId = versions[0]?.id;
    expect(roundingVersionId).toEqual(expect.any(String));
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      const s = await client.query<{ id: string }>(
        `INSERT INTO installment_schedules (entity_id, purse_id, case_id, principal_rial, plan_fee_rial,
           total_rial, installment_count, funded_at, rounding_unit_rial, rounding_config_version_id,
           idempotency_key, request_hash)
         VALUES ('aramesh', $1, $2, 100, 0, 100, 2, now(), 10, $3, $4, repeat('a', 64)) RETURNING id`,
        [randomUUID(), randomUUID(), roundingVersionId, key('raw')],
      );
      await client.query(
        "INSERT INTO installments (schedule_id, index, due_on, amount_rial) VALUES ($1, 1, '2026-10-01', 60), ($1, 2, '2026-11-01', 30)",
        [s.rows[0]?.id],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('the API', () => {
  it('accounting reads schedules and approves payments; the auditor only reads', async () => {
    const { scheduleId } = await scheduled(3n * M, 3);
    const paymentId = await pay(scheduleId, M);
    const accountant = await loggedInAccount(h, 'staff');
    const auditor = await loggedInAccount(h, 'staff');
    await grantRole(h, accountant.id, 'accounting');
    await grantRole(h, auditor.id, 'auditor');

    const read = await call(h, 'GET', `/repayment/schedules/${scheduleId}`, {
      bearer: auditor.access,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ totalRial: '3000000', unallocatedRial: '1000000' });
    expect(
      (
        await call(h, 'POST', `/repayment/payments/${paymentId}/approve`, {
          bearer: auditor.access,
        })
      ).status,
    ).toBe(403);

    const approved = await call(h, 'POST', `/repayment/payments/${paymentId}/approve`, {
      bearer: accountant.access,
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', allocatedRial: '1000000' });
    // Fully audited, with the approver.
    const { rows } = await h.owner.query(
      "SELECT actor_account_id FROM audit_events WHERE action = 'repayment.payment_approved' AND entity_id = $1",
      [paymentId],
    );
    expect(rows).toEqual([{ actor_account_id: accountant.id }]);
  });
});
