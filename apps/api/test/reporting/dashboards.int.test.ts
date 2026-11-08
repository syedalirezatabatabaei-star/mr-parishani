import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { ReportService } from '../../src/modules/reporting/report.service';
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
 * Task 7-5 (doc 17 §3; docs/decisions/task-7-5-decisions.md): the CEO's tiles and trend equal
 * the ledger's own sums; a unit's dashboard for its own unit, its managers and read-only roles;
 * the doctor's rank in their field. Read only, on the reporting connection.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let ceo: LoggedInAccount;
let support: LoggedInAccount;
let accounting: LoggedInAccount;
const texts = new CapturingTextSender();
const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

async function ledger(where: string, expr: string): Promise<string> {
  const { rows } = await h.owner.query<Row>(
    `SELECT coalesce(${expr}, 0)::text AS v FROM ledger_entries e
     JOIN ledger_accounts a ON a.id = e.account_id
     JOIN journal_entries j ON j.id = e.journal_entry_id WHERE ${where}`,
  );
  return rows[0]?.['v'] as string;
}

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  w = await creditWorld(h);
  ceo = await w.role('ceo');
  support = await w.role('support');
  accounting = await w.role('accounting');
  const steps = fundingSteps(h, w, {
    manager: await w.role('credit_manager'),
    finance: accounting,
  });
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
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
  const repayment = h.app.get(RepaymentService);
  const purse = await h.app.get(WalletService).summary(purseId);
  const [scheduleId] = await repayment.schedulesOf(purse.caseId);
  const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
    idempotencyKey: `test:dashboards:${scheduleId ?? ''}`,
    scheduleId: scheduleId ?? '',
    amountRial: 1_000_000n,
    receivedAt: new Date(),
    reference: 'TRK-DASH-1',
    paidOn: '2026-10-01',
    channel: 'manual_receipt',
  });
  await repayment.approvePayment(CLI_ACTOR, paymentId);
  // A complaint about the doctor (open), and two support tickets, one past its deadline.
  const p = await w.patient();
  await w.as(p, 'POST', '/me/tickets', {
    topicCode: 'complaint_general',
    subject: 'شکایت',
    body: 'متن شکایت',
    links: [],
  });
  await h.app.get(ReportService).refreshViews();
}, 300_000);

afterAll(async () => {
  await h.close();
});

describe('the CEO’s dashboard', () => {
  it('tiles and the six months’ trend equal the ledger’s sums; only for the CEO', async () => {
    const r = await w.staff(ceo, 'GET', '/reporting/dashboards/ceo');
    expect(r.status).toBe(200);
    const charged = await ledger(
      `a.code = 'purse.approved' AND a.owner_type = 'purse' AND j.event_type = 'wallet.charge'`,
      "sum(CASE e.direction WHEN 'debit' THEN e.amount_rial ELSE 0 END)",
    );
    const debt = await ledger(
      `a.code = 'borrower.debt' AND a.owner_type = 'purse'`,
      "sum(CASE e.direction WHEN 'debit' THEN e.amount_rial ELSE -e.amount_rial END)",
    );
    const collected = await ledger(
      `a.code = 'borrower.debt' AND a.owner_type = 'purse'
       AND j.event_type = 'repayment.payment_allocated'`,
      "sum(CASE e.direction WHEN 'credit' THEN e.amount_rial ELSE 0 END)",
    );
    // Everything of this world happened this month.
    expect(r.body).toMatchObject({
      chargedThisMonthRial: charged,
      outstandingDebtRial: debt,
      openComplaints: 1,
    });
    expect(BigInt(charged)).toBeGreaterThan(0n);
    const trend = r.body['trend'] as Body[];
    expect(trend).toHaveLength(6);
    expect(trend.at(-1)).toMatchObject({ chargedRial: charged, collectedRial: collected });
    expect(trend.slice(0, 5).every((m) => m['chargedRial'] === '0')).toBe(true);
    expect(trend.at(-1)?.['month']).toMatch(/^[۰-۹]{4}\/[۰-۹]{2}$/);
    expect(r.body['activeCases']).toBeGreaterThan(0);
    expect(r.body['asOf']).not.toBeNull();
    expect((await w.staff(accounting, 'GET', '/reporting/dashboards/ceo')).status).toBe(403);
  });
});

describe('a unit’s dashboard', () => {
  it('its queue, deadlines at risk and agents; another unit refused', async () => {
    const own = await w.staff(support, 'GET', '/reporting/dashboards/units/support');
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ unit: 'support', open: 1, atRiskMinutes: 1440 });
    const opened = own.body['opened'] as Body[];
    expect(opened).toHaveLength(14);
    expect(opened.at(-1)?.['tickets']).toBe(1);
    expect((await w.staff(support, 'GET', '/reporting/dashboards/units/accounting')).status).toBe(
      403,
    );
    expect((await w.staff(ceo, 'GET', '/reporting/dashboards/units/accounting')).status).toBe(200);
  });
});

describe('the doctor’s rank', () => {
  it('patients completed in ninety days, among the doctors of the field', async () => {
    const r = await w.staff(w.doctor, 'GET', '/reporting/dashboards/doctor');
    expect(r.status).toBe(200);
    expect(r.body['ranks']).toEqual([
      expect.objectContaining({ treatmentField: 'dental', patients: 1, rank: 1, of: 1 }),
    ]);
    expect((await w.staff(support, 'GET', '/reporting/dashboards/doctor')).status).toBe(403);
  });
});
