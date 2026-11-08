import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { REPAYMENT, type RepaymentPort } from '../../src/common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../src/common/wallet/wallet.port';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * A settled case still new (owner 1405/07/15): never passed on automatically (new ->
 * advising -> completed is not taken), the payment approved all the same, staff alerted;
 * staff take it up and complete it themselves, only once the chain allows it.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let finance: Staff;
let advisor: Staff;
let strategy: Staff;
let steps: ReturnType<typeof fundingSteps>;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  advisor = await w.role('advisor');
  strategy = await w.role('strategy_manager');
  steps = fundingSteps(h, w, { manager, finance });
}, 180_000);

afterAll(async () => {
  await h.close();
});

const repayment = () => h.app.get<RepaymentPort>(REPAYMENT);
/** The case assigned to the advisor by hand, with a reason, as a strategy manager does. */
const ownCase = async (caseId: string) => {
  const moved = await w.staff(strategy, 'POST', `/lead/cases/${caseId}/assignments`, {
    accountId: advisor.id,
    reason: 'مشاور این پرونده',
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(201);
};
const wallet = () => h.app.get<WalletPort>(WALLET);

describe('a settled case still new (owner 1405/07/15)', () => {
  it('the payment approved, the case left new with an alert; staff take it up and complete it', async () => {
    const { patient, applicationId } = await steps.approved();
    await steps.complete(patient, applicationId);
    const purseId = await steps.fund(applicationId);
    const caseId = (await wallet().summary(purseId)).caseId;
    const { rows } = await h.owner.query<Row>(
      'SELECT schedule_id FROM funding_requests WHERE purse_id = $1',
      [purseId],
    );
    const scheduleId = rows[0]?.['schedule_id'] as string;
    const status = async () =>
      (await h.owner.query<Row>('SELECT status FROM cases WHERE id = $1', [caseId])).rows[0]?.[
        'status'
      ];
    expect(await status()).toBe('new');

    // Paid in full: approved (never failing for the case), settled, the case not completed.
    const { paymentId } = await repayment().registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId,
      amountRial: (await repayment().schedule(scheduleId)).outstandingRial,
      receivedAt: new Date(),
    });
    const approved = await w.staff(finance, 'POST', `/repayment/payments/${paymentId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await status()).toBe('new');
    const { rows: events } = await h.owner.query<Row>(
      `SELECT payload FROM outbox_events WHERE event_type = 'loan.settled' AND payload->>'caseId' = $1`,
      [caseId],
    );
    expect(events.map((e) => e['payload'])).toMatchObject([{ caseCompleted: false }]);
    const { rows: hops } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM case_status_changes
       WHERE case_id = $1 AND from_status IS NOT NULL`,
      [caseId],
    );
    expect(hops[0]?.['n']).toBe(0);

    // Staff see it: an advisor works its own cases only (R18, owner 1405/07/18), so this one
    // is assigned to it first.
    await ownCase(caseId);
    const alerts = await w.staff(advisor, 'GET', '/lead/case-completions');
    expect(alerts.status).toBe(200);
    expect((alerts.body as unknown as Body[]).find((a) => a['id'] === caseId)).toMatchObject({
      status: 'new',
    });

    // Not from new: the chain first.
    const early = await w.staff(advisor, 'POST', `/lead/cases/${caseId}/complete`);
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('case_not_ready');
    expect((await w.staff(advisor, 'POST', `/lead/cases/${caseId}/advising`)).status).toBe(200);
    const done = await w.staff(advisor, 'POST', `/lead/cases/${caseId}/complete`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await status()).toBe('completed');

    // Closed: no longer listed.
    const after = await w.staff(advisor, 'GET', '/lead/case-completions');
    expect((after.body as unknown as Body[]).some((a) => a['id'] === caseId)).toBe(false);
  });

  it('a case not settled cannot be completed by this path', async () => {
    const { patient, applicationId } = await steps.approved();
    await steps.complete(patient, applicationId);
    const purseId = await steps.fund(applicationId);
    const caseId = (await wallet().summary(purseId)).caseId;
    await ownCase(caseId);
    await w.staff(advisor, 'POST', `/lead/cases/${caseId}/advising`);
    const refused = await w.staff(advisor, 'POST', `/lead/cases/${caseId}/complete`);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('case_not_settled');
  });
});
