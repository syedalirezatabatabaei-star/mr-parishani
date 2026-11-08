import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { DATABASE, type Database } from '../../src/db/database.module';
import { createPool } from '../../src/db/pool';
import type { Alert, AlertSink } from '../../src/infra/ops/alerts';
import { WorkerRuntime } from '../../src/infra/outbox/worker-runtime';
import { LedgerBalanceApplier } from '../../src/modules/ledger/balance-applier';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { WorkerModule } from '../../src/worker.module';
import { call, grantRole, loggedInAccount, startHarness, type Harness } from '../identity/harness';
import { scheduleVersionsNow } from '../repayment/rounding-version';

let h: Harness;
let report: Pool;
let worker: INestApplicationContext;
let runtime: WorkerRuntime;
let reconciliation: LedgerReconciliation;
const alerts: Alert[] = [];
const sink: AlertSink = {
  raise(alert) {
    alerts.push(alert);
    return Promise.resolve();
  },
};
let counter = 0;
const key = (label: string) => `recon-${label}-${String(++counter)}-${String(Date.now())}`;
const M = 1_000_000n;

/** Relays every event and waits until every journal is in account_balances. */
async function applyAll(): Promise<void> {
  for (;;) {
    const { published } = await runtime.relayOnce();
    if (published === 0) break;
  }
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await h.owner.query<{ pending: number }>(`
      SELECT count(*)::int AS pending FROM journal_entries j
      WHERE NOT EXISTS (SELECT 1 FROM ledger_balance_applications a WHERE a.journal_entry_id = j.id)`);
    if (rows[0]?.pending === 0) return;
    if (Date.now() > deadline) throw new Error('journals were not applied in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A whole case: purse, services, schedule, payments. */
async function wholeCase() {
  const wallet = h.app.get(WalletService);
  const repayment = h.app.get(RepaymentService);
  const scope = {
    centerNodeId: randomUUID(),
    doctorNodeId: randomUUID(),
    treatmentFieldCode: 'dental',
  };
  const { purseId } = await wallet.approveCredit(CLI_ACTOR, {
    idempotencyKey: key('approve'),
    caseId: randomUUID(),
    borrowerPersonId: randomUUID(),
    amountRial: 12n * M,
    scope,
  });
  await wallet.charge(CLI_ACTOR, purseId, { idempotencyKey: key('charge') });
  const auth = { authorizationId: `a-${String(counter)}` };
  await wallet.reserve(CLI_ACTOR, purseId, {
    idempotencyKey: key('r'),
    ...auth,
    amountRial: 8n * M,
    service: scope,
  });
  await wallet.registerService(CLI_ACTOR, purseId, {
    idempotencyKey: key('s'),
    ...auth,
    amountRial: 8n * M,
  });
  await wallet.finalize(CLI_ACTOR, purseId, {
    idempotencyKey: key('f'),
    ...auth,
    amountRial: 8n * M,
  });
  const { scheduleId } = await repayment.createSchedule(CLI_ACTOR, {
    idempotencyKey: key('sched'),
    purseId,
    installmentCount: 6,
    planFeeRial: 600_000n,
    ...(await scheduleVersionsNow(h)),
  });
  const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
    idempotencyKey: key('pay'),
    scheduleId,
    amountRial: 5n * M,
    receivedAt: new Date(),
  });
  await repayment.approvePayment(CLI_ACTOR, paymentId);
  return { purseId };
}

beforeAll(async () => {
  h = await startHarness();
  report = createPool(h.db.reportUrl, 'test-report');
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot({ alertSink: sink, relayLoop: false }),
    { logger: false },
  );
  runtime = worker.get(WorkerRuntime);
  await runtime.start();
  reconciliation = worker.get(LedgerReconciliation);
});

afterAll(async () => {
  await worker.close();
  await report.end();
  await h.close();
});

describe('account_balances follows the ledger', () => {
  it('after whole cases, every balance equals the sum of its entries and the run is clean', async () => {
    await wholeCase();
    await wholeCase();
    await applyAll();
    const { rows } = await h.owner.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM (
        SELECT e.account_id, sum(e.amount_rial) FILTER (WHERE direction = 'debit') AS d,
               sum(e.amount_rial) FILTER (WHERE direction = 'credit') AS c
        FROM ledger_entries e GROUP BY e.account_id
      ) x JOIN account_balances b ON b.account_id = x.account_id
      WHERE coalesce(x.d, 0) <> b.debit_rial OR coalesce(x.c, 0) <> b.credit_rial`);
    expect(rows[0]?.n).toBe(0);

    alerts.length = 0;
    const result = await reconciliation.run();
    expect(result).toMatchObject({ clean: true, discrepancies: [], overdueUnapplied: 0 });
    expect(result.accountsChecked).toBeGreaterThan(10);
    expect(alerts).toEqual([]);
    const aramesh = result.reports.find((r) => r.entityId === 'aramesh');
    expect(aramesh?.balanced).toBe(true);
    expect(aramesh?.totalDebitRial).toBeGreaterThan(0n);
    expect(aramesh?.totalDebitRial).toBe(aramesh?.totalCreditRial);
  });

  it('a redelivered event adds nothing a second time', async () => {
    const { rows } = await h.owner.query<{ id: string }>(
      'SELECT journal_entry_id AS id FROM ledger_balance_applications ORDER BY created_at LIMIT 1',
    );
    const before = await h.owner.query(
      'SELECT account_id, debit_rial, credit_rial FROM account_balances ORDER BY account_id',
    );
    const applier = worker.get(LedgerBalanceApplier);
    await worker.get<Database>(DATABASE).transaction((tx) =>
      applier.handle(
        {
          id: randomUUID(),
          type: 'ledger.journal_posted',
          aggregateType: 'journal_entry',
          aggregateId: rows[0]?.id ?? '',
          payload: { journalEntryId: rows[0]?.id },
          occurredAt: new Date().toISOString(),
        },
        tx,
      ),
    );
    const after = await h.owner.query(
      'SELECT account_id, debit_rial, credit_rial FROM account_balances ORDER BY account_id',
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe('ACCEPTANCE: an artificial discrepancy raises an alert', () => {
  it('a balance changed behind the ledger is found, recorded and alerted', async () => {
    const { rows } = await h.owner.query<{ account_id: string }>(
      'SELECT account_id FROM account_balances ORDER BY account_id LIMIT 1',
    );
    const tampered = rows[0]?.account_id ?? '';
    await h.owner.query(
      'UPDATE account_balances SET debit_rial = debit_rial + 1234 WHERE account_id = $1',
      [tampered],
    );
    alerts.length = 0;
    try {
      const result = await reconciliation.run();
      expect(result.clean).toBe(false);
      expect(result.discrepancies).toHaveLength(1);
      expect(result.discrepancies[0]).toMatchObject({
        kind: 'balance_mismatch',
        accountId: tampered,
      });
      const d = result.discrepancies[0];
      expect((d?.actualDebitRial ?? 0n) - (d?.expectedDebitRial ?? 0n)).toBe(1234n);
      expect(alerts.map((a) => a.code)).toEqual(['ledger_mismatch']);

      // Recorded as evidence, with the run.
      const recorded = await h.owner.query(
        'SELECT r.clean, d.kind, d.account_id FROM ledger_discrepancies d JOIN ledger_reconciliation_runs r ON r.id = d.run_id WHERE r.id = $1',
        [result.runId],
      );
      expect(recorded.rows).toEqual([
        { clean: false, kind: 'balance_mismatch', account_id: tampered },
      ]);
    } finally {
      await h.owner.query(
        'UPDATE account_balances SET debit_rial = debit_rial - 1234 WHERE account_id = $1',
        [tampered],
      );
    }
    expect((await reconciliation.run()).clean).toBe(true);
  });

  it('a journal still in the queue is not a discrepancy, until it waits too long', async () => {
    const ledger = h.app.get(LedgerService);
    const open = (code: string, kind: 'asset' | 'income') =>
      ledger.openAccount({
        entityId: 'aramesh',
        code,
        name: code,
        kind,
        ownerType: 'company',
        ownerId: null,
      });
    const bank = await open('bank.collection', 'asset');
    const income = await open('company.fee_income', 'income');
    await ledger.postJournal(CLI_ACTOR, {
      entityId: 'aramesh',
      eventType: 'wallet.test_lag',
      occurredAt: new Date(),
      idempotencyKey: key('lag'),
      lines: [
        { accountId: bank.id, direction: 'debit', amountRial: 999n },
        { accountId: income.id, direction: 'credit', amountRial: 999n },
      ],
    });
    alerts.length = 0;
    expect((await reconciliation.run()).clean).toBe(true);
    const later = await reconciliation.run(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(later.overdueUnapplied).toBe(1);
    expect(later.discrepancies).toEqual([]);
    expect(alerts.map((a) => a.code)).toEqual(['ledger_lag']);
    await applyAll();
  });
});

describe('the reporting role', () => {
  it('reads the ledger and the reports, and can write nothing', async () => {
    const { rows } = await report.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM account_balances',
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
    for (const statement of [
      'UPDATE account_balances SET debit_rial = 0',
      'INSERT INTO ledger_reconciliation_runs (started_at, finished_at, accounts_checked, journals_applied, mismatches, invariant_violations, unbalanced_entities, overdue_unapplied, clean) VALUES (now(), now(), 0, 0, 0, 0, 0, 0, true)',
      'SELECT 1 FROM user_accounts',
      'SELECT 1 FROM credit_purses',
    ]) {
      await expect(report.query(statement)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('results are written as the application, through the primary', async () => {
    const { rows } = await h.owner.query(
      'SELECT count(*)::int AS n FROM ledger_reconciliation_runs',
    );
    expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
    await expect(
      worker
        .get<Database>(DATABASE)
        .execute(sql`UPDATE ledger_reconciliation_runs SET clean = true`),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('the API', () => {
  it('auditors read the latest runs with their discrepancies and reports', async () => {
    const auditor = await loggedInAccount(h, 'staff');
    await grantRole(h, auditor.id, 'auditor');
    const res = await call(h, 'GET', '/ledger/reconciliation/runs?limit=20', {
      bearer: auditor.access,
    });
    expect(res.status).toBe(200);
    const runs = res.body as unknown as {
      clean: boolean;
      discrepancies: unknown[];
      reports: unknown[];
    }[];
    expect(runs.some((r) => !r.clean && r.discrepancies.length === 1)).toBe(true);
    expect(runs[0]?.reports.length).toBeGreaterThan(0);
  });

  it('owner 1405/07/26: every run, discrepancy and report rial by rial as the database has it', async () => {
    const auditor = await loggedInAccount(h, 'staff');
    await grantRole(h, auditor.id, 'auditor');
    const res = await call(h, 'GET', '/ledger/reconciliation/runs?limit=100', {
      bearer: auditor.access,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const runs = res.body as unknown as {
      id: string;
      accountsChecked: number;
      mismatches: number;
      discrepancies: Record<string, unknown>[];
      reports: Record<string, unknown>[];
    }[];
    const { rows: inRuns } = await h.owner.query<{
      id: string;
      checked: number;
      mismatches: number;
    }>(
      `SELECT id, accounts_checked AS checked, mismatches FROM ledger_reconciliation_runs
        ORDER BY started_at DESC, id DESC LIMIT 100`,
    );
    expect(runs.map((r) => [r.id, r.accountsChecked, r.mismatches])).toEqual(
      inRuns.map((r) => [r.id, r.checked, r.mismatches]),
    );
    const ids = runs.map((r) => r.id);
    const { rows: discrepancies } = await h.owner.query<Record<string, string>>(
      `SELECT run_id, kind, account_id AS "accountId",
              expected_debit_rial::text AS "expectedDebitRial",
              expected_credit_rial::text AS "expectedCreditRial",
              actual_debit_rial::text AS "actualDebitRial",
              actual_credit_rial::text AS "actualCreditRial"
         FROM ledger_discrepancies WHERE run_id = ANY ($1::uuid[]) ORDER BY created_at, id`,
      [ids],
    );
    const { rows: reports } = await h.owner.query<Record<string, unknown>>(
      `SELECT run_id, entity_id AS "entityId", report_date::text AS "reportDate",
              day_debit_rial::text AS "dayDebitRial", day_credit_rial::text AS "dayCreditRial",
              total_debit_rial::text AS "totalDebitRial", total_credit_rial::text AS "totalCreditRial",
              balanced
         FROM ledger_daily_reports WHERE run_id = ANY ($1::uuid[]) ORDER BY entity_id`,
      [ids],
    );
    expect(discrepancies.length).toBeGreaterThan(0);
    const withoutRun = (row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'run_id'));
    for (const run of runs) {
      expect(run.discrepancies).toEqual(
        discrepancies.filter((d) => d['run_id'] === run.id).map(withoutRun),
      );
      expect(run.reports).toEqual(reports.filter((r) => r['run_id'] === run.id).map(withoutRun));
    }
    // Totals of the latest report balance, digit for digit.
    const latest = runs[0]?.reports[0];
    expect(latest?.['totalDebitRial']).toBe(latest?.['totalCreditRial']);
  });
});

describe('invariants of doc 02 (last: it leaves the ledger unclean on purpose)', () => {
  it('a purse account below zero is reported and alerted', async () => {
    const ledger = h.app.get(LedgerService);
    const purse = await ledger.openAccount({
      entityId: 'aramesh',
      code: 'purse.available',
      name: 'purse',
      kind: 'memo',
      ownerType: 'purse',
      ownerId: randomUUID(),
    });
    const income = await ledger.openAccount({
      entityId: 'aramesh',
      code: 'company.fee_income',
      name: 'income',
      kind: 'income',
      ownerType: 'company',
      ownerId: null,
    });
    // A balanced document the wallet would never write: it takes the purse below zero.
    await ledger.postJournal(CLI_ACTOR, {
      entityId: 'aramesh',
      eventType: 'wallet.test_negative',
      occurredAt: new Date(),
      idempotencyKey: key('neg'),
      lines: [
        { accountId: purse.id, direction: 'debit', amountRial: 500n },
        { accountId: income.id, direction: 'credit', amountRial: 500n },
      ],
    });
    await applyAll();
    alerts.length = 0;
    const result = await reconciliation.run();
    expect(result.discrepancies).toEqual([
      expect.objectContaining({ kind: 'negative_balance', accountId: purse.id }),
    ]);
    expect(alerts.map((a) => a.code)).toEqual(['ledger_invariant']);
  });
});
