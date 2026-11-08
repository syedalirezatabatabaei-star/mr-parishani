import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { REPORT_VIEWS, ReportService } from '../../src/modules/reporting/report.service';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import {
  CapturingTextSender,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 7-4 (doc 17 §2; §9 test 7; docs/decisions/task-7-4-decisions.md): every money figure of
 * the settlement, receivables and purse reports equals the direct sum of the ledger's entries
 * for the same accounts, events and range; every report's query reads a materialized view or
 * an index; each report for its audience only, the treatment field only for who may see it.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let ceo: LoggedInAccount;
let accounting: LoggedInAccount;
let agent: LoggedInAccount;
let support: LoggedInAccount;
let doctorNodeId: string;
let purseId: string;
const texts = new CapturingTextSender();

const reports = () => h.app.get(ReportService);
const run = (who: LoggedInAccount, code: string, params: Body = {}) =>
  w.staff(who, 'POST', `/reporting/reports/${code}/run`, { params });
const rowsOf = (r: { body: Body }) => r.body['rows'] as Body[];
const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

/** The direct sum of the ledger's entries: the figure every report must equal (test 7). */
async function ledger(
  where: string,
  params: unknown[],
  expr = "sum(CASE e.direction WHEN 'debit' THEN e.amount_rial ELSE 0 END)",
): Promise<string> {
  const { rows } = await h.owner.query<Row>(
    `SELECT coalesce(${expr}, 0)::text AS v
     FROM ledger_entries e
     JOIN ledger_accounts a ON a.id = e.account_id
     JOIN journal_entries j ON j.id = e.journal_entry_id
     LEFT JOIN journal_entries r ON r.id = j.reverses_journal_entry_id
     WHERE ${where}`,
    params,
  );
  return rows[0]?.['v'] as string;
}
const CREDIT = "sum(CASE e.direction WHEN 'credit' THEN e.amount_rial ELSE 0 END)";
const DEBIT_MINUS_CREDIT =
  "sum(CASE e.direction WHEN 'debit' THEN e.amount_rial ELSE -e.amount_rial END)";
const CREDIT_MINUS_DEBIT =
  "sum(CASE e.direction WHEN 'credit' THEN e.amount_rial ELSE -e.amount_rial END)";

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  w = await creditWorld(h);
  ceo = await w.role('ceo');
  accounting = await w.role('accounting');
  agent = await w.role('collection');
  support = await w.role('support');
  const steps = fundingSteps(h, w, {
    manager: await w.role('credit_manager'),
    finance: accounting,
  });
  // A whole loan: funded, a service final (the doctor's payable and its fee), a slip allocated.
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  purseId = await steps.fund(applicationId);
  const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
    purseId,
    proformaLineIds: [lines[0]?.['id']],
  });
  await w.staff(w.doctor, 'POST', `/service/authorizations/${made.body['id'] as string}/deliver`, {
    code: lastCode(patient.mobile),
  });
  await h.app.get(SettlementService).accrue(CLI_ACTOR, made.body['id'] as string);
  const { rows } = await h.owner.query<Row>(
    'SELECT doctor_node_id FROM doctor_payables ORDER BY created_at DESC LIMIT 1',
  );
  doctorNodeId = rows[0]?.['doctor_node_id'] as string;
  const repayment = h.app.get(RepaymentService);
  const purse = await h.app.get(WalletService).summary(purseId);
  const [scheduleId] = await repayment.schedulesOf(purse.caseId);
  const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
    idempotencyKey: `test:v1-reports:${scheduleId ?? ''}`,
    scheduleId: scheduleId ?? '',
    amountRial: 1_000_000n,
    receivedAt: new Date(),
    reference: 'TRK-V1-1',
    paidOn: '2026-10-01',
    channel: 'manual_receipt',
  });
  await repayment.approvePayment(CLI_ACTOR, paymentId);
  // A ticket assigned by the engine, for the agents' report.
  await w.staff(await w.role('strategy_manager'), 'PUT', '/lead/assignment/shares', {
    queueCode: 'ticket_support',
    shares: [{ accountId: support.id, percent: 100 }],
    reason: 'سهم صف تیکت',
  });
  const p = await w.patient();
  await w.as(p, 'POST', '/me/tickets', {
    topicCode: 'general',
    subject: 'پرسش',
    body: 'متن',
    links: [],
  });
  await reports().refreshViews();
}, 300_000);

afterAll(async () => {
  await h.close();
});

describe('test 7: the money figures equal the ledger’s sums', () => {
  it('the centers’ settlement, by the doctor’s accounts, today and all time', async () => {
    const today = await run(accounting, 'settlement_centers', {
      range: { relative: 'today' },
      doctorNodeId,
    });
    expect(today.status).toBe(200);
    const [row] = rowsOf(today);
    expect(row).toBeDefined();
    // The doctor's name, from org_nodes on the reporting connection (0070).
    const { rows: node } = await h.owner.query<Row>('SELECT name FROM org_nodes WHERE id = $1', [
      doctorNodeId,
    ]);
    expect(row?.['doctor']).toBe(node[0]?.['name']);
    expect(row?.['doctor']).toBeTruthy();
    const day =
      "(j.occurred_at AT TIME ZONE 'Asia/Tehran')::date = (now() AT TIME ZONE 'Asia/Tehran')::date";
    const payable = `a.code = 'doctor.payable' AND a.owner_type = 'doctor' AND a.owner_id = $1`;
    const fee = `a.code = 'doctor.fee_receivable' AND a.owner_type = 'doctor' AND a.owner_id = $1`;
    expect(row?.['accrued']).toBe(await ledger(`${payable} AND ${day}`, [doctorNodeId], CREDIT));
    expect(BigInt(row?.['accrued'] as string)).toBeGreaterThan(0n);
    expect(row?.['fees']).toBe(await ledger(`${fee} AND ${day}`, [doctorNodeId]));
    expect(row?.['payableBalance']).toBe(await ledger(payable, [doctorNodeId], CREDIT_MINUS_DEBIT));
    expect(row?.['feeBalance']).toBe(await ledger(fee, [doctorNodeId], DEBIT_MINUS_CREDIT));
    expect(row?.['paid']).toBe(
      await ledger(`${payable} AND ${day} AND j.event_type = 'settlement.payout_paid'`, [
        doctorNodeId,
      ]),
    );
  });

  it('receivables: the whole debt and what was collected, by the borrowers’ accounts', async () => {
    const r = await run(agent, 'receivables_summary', { range: { relative: 'today' } });
    expect(r.status).toBe(200);
    const by = new Map(rowsOf(r).map((x) => [x['metric'], x]));
    const debt = `a.code = 'borrower.debt' AND a.owner_type = 'purse'`;
    expect(by.get('مانده بدهی کل')?.['amount']).toBe(await ledger(debt, [], DEBIT_MINUS_CREDIT));
    expect(BigInt(by.get('مانده بدهی کل')?.['amount'] as string)).toBeGreaterThan(0n);
    expect(by.get('وصول‌شده در بازه')?.['amount']).toBe(
      await ledger(
        `${debt} AND j.event_type = 'repayment.payment_allocated'
         AND (j.occurred_at AT TIME ZONE 'Asia/Tehran')::date = (now() AT TIME ZONE 'Asia/Tehran')::date`,
        [],
        CREDIT,
      ),
    );
    expect(BigInt(by.get('وصول‌شده در بازه')?.['amount'] as string)).toBe(1_000_000n);
  });

  it('the purses: charged and remaining, by the purses’ own accounts', async () => {
    const r = await run(ceo, 'wallet_usage', {});
    const purse = `a.owner_type = 'purse' AND a.owner_id = $1`;
    const charged = await ledger(
      `${purse} AND a.code = 'purse.approved' AND j.event_type = 'wallet.charge'`,
      [purseId],
    );
    const remaining = await ledger(
      `${purse} AND a.code IN ('purse.available', 'purse.reserved', 'purse.consumed_pending')`,
      [purseId],
      CREDIT_MINUS_DEBIT,
    );
    const consumed = await ledger(
      `${purse} AND a.code = 'purse.consumed_pending' AND j.event_type = 'wallet.finalize'`,
      [purseId],
    );
    // One purse in this world: its center's row is the purse.
    const [row] = rowsOf(r);
    expect(row).toMatchObject({ charged, remaining, consumed, purses: 1 });
    // The center's name, from org_nodes on the reporting connection (0070).
    expect(row?.['center']).toBeTruthy();
    expect(BigInt(charged)).toBeGreaterThan(0n);
  });
});

describe('every report reads a materialized view or an index', () => {
  it('the plan of each one’s own query', async () => {
    const access = await h.app.get<AccessPort>(ACCESS_PORT).resolve(ceo.id);
    const codes = reports()
      .list(access)
      .map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'tickets',
        'tickets_summary',
        'sales_funnel',
        'sales_abandonment',
        'credit_summary',
        'credit_grades',
        'settlement_centers',
        'receivables_summary',
        'receivables_aging',
        'agents_performance',
        'wallet_usage',
      ]),
    );
    const without: string[] = [];
    for (const code of codes) {
      const plan = await reports().explain(access, code, {}, true);
      if (!/report_[a-z_]+|installment_states|Index/.test(plan)) {
        without.push(`${code}: ${plan.split(String.fromCharCode(10)).slice(0, 4).join(' / ')}`);
      }
    }
    expect(without).toEqual([]);
  });
});

describe('each report for its audience; the treatment field for who may see it', () => {
  it('collection reads receivables only, never a treatment, doctor or center', async () => {
    const r = await run(agent, 'receivables_aging', {});
    expect(r.status).toBe(200);
    expect((r.body['columns'] as Body[]).map((c) => c['key'])).toEqual([
      'bucket',
      'loans',
      'outstanding',
      'asOfDay',
    ]);
    for (const code of ['settlement_centers', 'wallet_usage', 'sales_funnel', 'credit_summary']) {
      expect((await run(agent, code)).status, code).toBe(404);
    }
    const listed = await w.staff(agent, 'GET', '/reporting/reports');
    // Its own unit's tickets too (ticket.work), which carry no treatment either.
    expect((listed.body as unknown as Body[]).map((d) => d['code']).sort()).toEqual([
      'receivables_aging',
      'receivables_summary',
      'tickets',
      'tickets_summary',
    ]);
  });

  it('the purses’ treatment field only with access.view_treatment', async () => {
    for (const who of [ceo, accounting]) {
      const access = await h.app.get<AccessPort>(ACCESS_PORT).resolve(who.id);
      const r = await run(who, 'wallet_usage');
      expect((r.body['columns'] as Body[]).some((c) => c['key'] === 'treatmentField')).toBe(
        access.permissions.has('access.view_treatment'),
      );
    }
  });
});

describe('freshness and the other reports', () => {
  it('asOf: the views’ last refresh, each recorded', async () => {
    const before = await h.owner.query<Row>('SELECT count(*)::int AS n FROM report_refreshes');
    const at = new Date();
    await reports().refreshViews(at);
    const after = await h.owner.query<Row>('SELECT count(*)::int AS n FROM report_refreshes');
    expect((after.rows[0]?.['n'] as number) - (before.rows[0]?.['n'] as number)).toBe(
      REPORT_VIEWS.length,
    );
    const r = await run(accounting, 'settlement_centers');
    expect(r.body['asOf']).toBe(at.toISOString());
    expect((await run(support, 'tickets_summary')).body['asOf']).toBeNull();
  });

  it('the funnel: every case of the range is new; conversions follow', async () => {
    const r = await run(ceo, 'sales_funnel', { range: { relative: 'today' } });
    const rows = rowsOf(r);
    const { rows: made } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM cases
       WHERE deleted_at IS NULL AND (created_at AT TIME ZONE 'Asia/Tehran')::date
         = (now() AT TIME ZONE 'Asia/Tehran')::date`,
    );
    expect(rows[0]).toMatchObject({ stage: 'تازه', reached: made[0]?.['n'] });
    expect(rows[0]?.['conversion']).toBeNull();
    expect(rows.map((x) => x['stage'])).toContain('پایان‌یافته');
  });

  it('the agents: the share set and the share taken; credit and tickets summed', async () => {
    const r = await run(ceo, 'agents_performance', { queue: 'ticket_support' });
    expect(rowsOf(r)).toContainEqual(
      expect.objectContaining({
        accountId: support.id,
        target: 100,
        actual: '100.00',
        autoAssigned: 1,
        workload: 1,
      }),
    );
    const credit = await run(ceo, 'credit_summary');
    expect(rowsOf(credit)[0]).toMatchObject({ metric: 'پرونده‌های ورودی' });
    expect(rowsOf(credit)[0]?.['count'] as number).toBeGreaterThan(0);
    const tickets = await run(ceo, 'tickets_summary');
    expect(rowsOf(tickets)).toContainEqual(
      expect.objectContaining({ unit: 'support', topic: 'general', total: 1, open: 1 }),
    );
  });
});
