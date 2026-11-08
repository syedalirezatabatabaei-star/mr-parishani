import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { ZOD_RESPONSE } from '../../src/common/zod-response';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { RepaymentController } from '../../src/modules/repayment/repayment.controller';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import {
  call,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { scheduleVersionsNow } from '../repayment/rounding-version';

/**
 * Owner 1405/07/26: the six financial routes (the seventh, the reconciliation runs, is in
 * reconciliation.int.test.ts) got a response schema and nothing else. Each answer is checked
 * here rial by rial against the rows in the database, with the schema check on
 * (SEPEHR_CHECK_RESPONSES=1); and a schema that fails after a payment's approval never takes
 * back what was committed.
 */

let h: Harness;
let ledger: LedgerService;
let wallet: WalletService;
let repayment: RepaymentService;
let reader: LoggedInAccount;
let accountant: LoggedInAccount;
let counter = 0;
const key = (label: string) => `fin-resp-${label}-${String(++counter)}-${String(Date.now())}`;
const M = 1_000_000n;
/** Beyond 2^53: exact only as a string. */
const BIG = 9_007_199_254_740_993n;

beforeAll(async () => {
  h = await startHarness();
  ledger = h.app.get(LedgerService);
  wallet = h.app.get(WalletService);
  repayment = h.app.get(RepaymentService);
  reader = await loggedInAccount(h, 'staff');
  await grantRole(h, reader.id, 'auditor');
  accountant = await loggedInAccount(h, 'staff');
  await grantRole(h, accountant.id, 'accounting');
});

afterAll(async () => {
  await h.close();
});

const get = (who: LoggedInAccount, path: string) => call(h, 'GET', path, { bearer: who.access });
const post = (who: LoggedInAccount, path: string, body?: unknown) =>
  call(h, 'POST', path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

async function scheduled(principal: bigint, count: number, planFee = 0n) {
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

/** The allocations of a payment as the database has them, oldest installment first. */
async function allocationsInDb(paymentId: string) {
  const { rows } = await h.owner.query<{ installmentId: string; amountRial: string }>(
    `SELECT a.installment_id AS "installmentId", a.amount_rial::text AS "amountRial"
       FROM payment_allocations a JOIN installments i ON i.id = a.installment_id
      WHERE a.payment_id = $1 ORDER BY i.index`,
    [paymentId],
  );
  return rows;
}

describe('the ledger, rial by rial', () => {
  it('a balance: the sums of its entries, and a net below zero on the credit side', async () => {
    const open = (code: string, kind: 'income' | 'asset') =>
      ledger
        .openAccount({
          entityId: 'aramesh',
          code,
          name: code,
          kind,
          ownerType: 'company',
          ownerId: null,
        })
        .then((r) => r.id);
    const bank = await open('bank.collection', 'asset');
    const income = await open('company.fee_income', 'income');
    for (const amount of [BIG, 7n]) {
      await ledger.postJournal(CLI_ACTOR, {
        entityId: 'aramesh',
        eventType: 'wallet.test_posting',
        occurredAt: new Date(),
        idempotencyKey: key('j'),
        lines: [
          { accountId: bank, direction: 'debit', amountRial: amount },
          { accountId: income, direction: 'credit', amountRial: amount },
        ],
      });
    }
    const inDb = async (accountId: string) => {
      const { rows } = await h.owner.query<{ d: string; c: string }>(
        `SELECT coalesce(sum(amount_rial) FILTER (WHERE direction = 'debit'), 0)::text AS d,
                coalesce(sum(amount_rial) FILTER (WHERE direction = 'credit'), 0)::text AS c
           FROM ledger_entries WHERE account_id = $1`,
        [accountId],
      );
      return rows[0];
    };
    const total = (BIG + 7n).toString();
    for (const [accountId, expected] of [
      [bank, { debitRial: total, creditRial: '0', netDebitRial: total }],
      [income, { debitRial: '0', creditRial: total, netDebitRial: `-${total}` }],
    ] as const) {
      const res = await get(reader, `/ledger/accounts/${accountId}/balance`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ accountId, ...expected });
      const db = await inDb(accountId);
      expect([res.body['debitRial'], res.body['creditRial']]).toEqual([db?.d, db?.c]);
    }
  });

  it('a journal: each line as its entry, and a reversal names the one it reverses', async () => {
    const open = (code: string, kind: 'income' | 'asset') =>
      ledger
        .openAccount({
          entityId: 'aramesh',
          code,
          name: code,
          kind,
          ownerType: 'company',
          ownerId: null,
        })
        .then((r) => r.id);
    const bank = await open('bank.collection', 'asset');
    const income = await open('company.fee_income', 'income');
    const posted = await ledger.postJournal(CLI_ACTOR, {
      entityId: 'aramesh',
      eventType: 'wallet.test_posting',
      occurredAt: new Date('2026-10-01T08:00:00Z'),
      idempotencyKey: key('j'),
      lines: [
        { accountId: bank, direction: 'debit', amountRial: BIG },
        { accountId: income, direction: 'credit', amountRial: BIG },
      ],
    });
    const res = await get(reader, `/ledger/journals/${posted.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: posted.id,
      entityId: 'aramesh',
      eventType: 'wallet.test_posting',
      occurredAt: '2026-10-01T08:00:00.000Z',
      reversesJournalEntryId: null,
      createdBy: null,
    });
    const { rows } = await h.owner.query<{
      id: string;
      account_id: string;
      direction: string;
      amount: string;
    }>(
      `SELECT id, account_id, direction, amount_rial::text AS amount
         FROM ledger_entries WHERE journal_entry_id = $1 ORDER BY direction DESC, id`,
      [posted.id],
    );
    const lines = res.body['lines'] as {
      id: string;
      accountId: string;
      direction: string;
      amountRial: string;
    }[];
    expect([...lines].sort((a, b) => (a.direction < b.direction ? 1 : -1))).toEqual(
      rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        direction: r.direction,
        amountRial: r.amount,
      })),
    );
    expect(lines.map((l) => l.amountRial)).toEqual([BIG.toString(), BIG.toString()]);
  });
});

describe('the purse and the schedule, rial by rial', () => {
  it('a purse: as the wallet computes it, and the approved amount after funding', async () => {
    const principal = 9_600_000n;
    const { purseId } = await scheduled(principal, 3);
    const res = await get(reader, `/wallet/purses/${purseId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = await wallet.summary(purseId);
    expect(res.body).toMatchObject({
      id: purseId,
      status: 'funded',
      approvedAmountRial: principal.toString(),
      balances: {
        approvedRial: s.balances.approvedRial.toString(),
        availableRial: s.balances.availableRial.toString(),
        reservedRial: s.balances.reservedRial.toString(),
        consumedPendingRial: s.balances.consumedPendingRial.toString(),
        borrowerDebtRial: s.balances.borrowerDebtRial.toString(),
      },
      reservations: [],
    });
    // Nothing spent yet: the whole approved amount is available.
    expect((res.body['balances'] as Record<string, string>)['availableRial']).toBe(
      principal.toString(),
    );
  });

  it('a schedule: each installment as its row, summing to principal plus plan fee', async () => {
    const { scheduleId } = await scheduled(10n * M + 1n, 3, 30_000n);
    const res = await get(reader, `/repayment/schedules/${scheduleId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      principalRial: '10000001',
      planFeeRial: '30000',
      totalRial: '10030001',
      paidRial: '0',
      outstandingRial: '10030001',
      unallocatedRial: '0',
    });
    const { rows } = await h.owner.query<{
      id: string;
      index: number;
      due_on: string;
      amount: string;
    }>(
      `SELECT id, index, due_on::text, amount_rial::text AS amount
         FROM installments WHERE schedule_id = $1 ORDER BY index`,
      [scheduleId],
    );
    const installments = res.body['installments'] as {
      id: string;
      index: number;
      dueOn: string;
      amountRial: string;
    }[];
    expect(
      installments.map((i) => ({
        id: i.id,
        index: i.index,
        dueOn: i.dueOn,
        amountRial: i.amountRial,
      })),
    ).toEqual(
      rows.map((r) => ({ id: r.id, index: r.index, dueOn: r.due_on, amountRial: r.amount })),
    );
    expect(installments.reduce((sum, i) => sum + BigInt(i.amountRial), 0n)).toBe(10_030_001n);
  });
});

describe('approving and rejecting a payment, rial by rial', () => {
  it('approved: what was allocated, to which installment, as the database has it; the surplus too', async () => {
    const { scheduleId } = await scheduled(3n * M, 3);
    const partial = await pay(scheduleId, 1_500_000n);
    const first = await post(accountant, `/repayment/payments/${partial}/approve`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      paymentId: partial,
      status: 'approved',
      allocatedRial: '1500000',
      surplusRial: '0',
    });
    expect(first.body['allocations']).toEqual(await allocationsInDb(partial));
    expect(
      (first.body['allocations'] as { amountRial: string }[]).map((a) => a.amountRial),
    ).toEqual(['1000000', '500000']);

    const over = await pay(scheduleId, 2_000_001n);
    const second = await post(accountant, `/repayment/payments/${over}/approve`);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ allocatedRial: '1500000', surplusRial: '500001' });
    expect(second.body['allocations']).toEqual(await allocationsInDb(over));
  });

  it('rejected: nothing allocated, none in the database', async () => {
    const { scheduleId } = await scheduled(3n * M, 3);
    const paymentId = await pay(scheduleId, M);
    const res = await post(accountant, `/repayment/payments/${paymentId}/reject`, {
      reason: 'واریز در بانک دیده نشد',
      kind: 'not_received',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      paymentId,
      status: 'rejected',
      allocatedRial: '0',
      allocations: [],
    });
    expect(await allocationsInDb(paymentId)).toEqual([]);
    const { rows } = await h.owner.query<{ status: string }>(
      'SELECT status FROM payments WHERE id = $1',
      [paymentId],
    );
    expect(rows[0]?.status).toBe('rejected');
  });

  it('a response schema that fails after the commit never takes back the approval', async () => {
    const { scheduleId } = await scheduled(3n * M, 3);
    const paymentId = await pay(scheduleId, M);
    // The handler itself, as Nest's metadata is kept on it.
    const handler = Object.getOwnPropertyDescriptor(RepaymentController.prototype, 'approve')
      ?.value as object;
    const schema: unknown = Reflect.getMetadata(ZOD_RESPONSE, handler);
    expect(schema).toBeDefined();
    // A schema nothing matches: the check after the handler fails, as a wrong one would.
    Reflect.defineMetadata(ZOD_RESPONSE, z.never(), handler);
    let failed;
    try {
      failed = await post(accountant, `/repayment/payments/${paymentId}/approve`);
    } finally {
      Reflect.defineMetadata(ZOD_RESPONSE, schema, handler);
    }
    expect(failed.status).toBe(500);

    // The approval, its allocations and its ledger document stand.
    const { rows } = await h.owner.query<{
      status: string;
      journal: string | null;
      posted: number;
    }>(
      `SELECT p.status, p.allocation_journal_entry_id AS journal,
              (SELECT count(*)::int FROM ledger_entries e
                WHERE e.journal_entry_id = p.allocation_journal_entry_id) AS posted
         FROM payments p WHERE p.id = $1`,
      [paymentId],
    );
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.journal).not.toBeNull();
    expect(rows[0]?.posted).toBeGreaterThan(0);
    expect((await allocationsInDb(paymentId)).map((a) => a.amountRial)).toEqual(['1000000']);
    const read = await get(reader, `/repayment/schedules/${scheduleId}`);
    expect(read.body).toMatchObject({ paidRial: '1000000', outstandingRial: '2000000' });
    const { rows: audits } = await h.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'repayment.payment_approved' AND entity_id = $1`,
      [paymentId],
    );
    expect(audits[0]?.n).toBe(1);
    // And approving again changes nothing: the first approval was the one.
    const again = await post(accountant, `/repayment/payments/${paymentId}/approve`);
    expect(again.status).not.toBe(500);
    expect((await allocationsInDb(paymentId)).map((a) => a.amountRial)).toEqual(['1000000']);
  });
});
