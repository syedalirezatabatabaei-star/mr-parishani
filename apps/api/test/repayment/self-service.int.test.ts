import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { CollectionService } from '../../src/modules/collection/collection.service';
import {
  grantRole,
  loggedInAccount,
  newIp,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Patient } from '../credit/world';

/**
 * Task 6-9's read endpoints (doc 15 §2–3, §6; rule 13): a borrower reads their own schedule,
 * slips and instruments only (another's is nothing); the collection agent reads a case's held
 * cheques by their last four characters; the collection manager reads the proposals waiting
 * for them; the SMS record marks what staff scheduled. Read only: nothing is posted.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let steps: ReturnType<typeof fundingSteps>;
let repayment: RepaymentService;
let wallet: WalletService;
let collection: CollectionService;
let agent: LoggedInAccount;
let manager: LoggedInAccount;
let support: LoggedInAccount;
let advisor: LoggedInAccount;

const role = async (code: string) => {
  const who = await loggedInAccount(h, 'staff');
  await grantRole(h, who.id, code);
  return who;
};

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  steps = fundingSteps(h, w, {
    manager: await w.role('credit_manager'),
    finance: await w.role('accounting'),
  });
  repayment = h.app.get(RepaymentService);
  wallet = h.app.get(WalletService);
  collection = h.app.get(CollectionService);
  agent = await role('collection');
  manager = await role('collection_manager');
  support = await role('support');
  advisor = await role('advisor');
  const strategy = await role('strategy_manager');
  await w.staff(strategy, 'PUT', '/lead/assignment/shares', {
    queueCode: 'collection',
    shares: [{ accountId: agent.id, percent: 100 }],
    reason: 'سهم صف وصول',
  });
}, 240_000);

afterAll(async () => {
  await h.close();
});

async function loan() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const purse = await wallet.summary(purseId);
  const [scheduleId] = await repayment.schedulesOf(purse.caseId);
  return { patient, applicationId, purse, scheduleId: scheduleId ?? '' };
}

const mine = (p: Patient, path: string) =>
  fetch(`${h.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${p.token}`, 'x-forwarded-for': newIp() },
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe('the borrower reads their own loan (task 6-9)', () => {
  it('their schedule and slips; another patient gets nothing; staff are refused', async () => {
    const l = await loan();
    const own = await mine(
      l.patient,
      `/me/repayment/schedules?creditApplicationId=${l.applicationId}`,
    );
    expect(own.status).toBe(200);
    const [schedule] = own.body as Body[];
    expect(schedule).toMatchObject({ id: l.scheduleId, paidRial: '0' });
    expect((schedule?.['installments'] as Body[])[0]).toMatchObject({
      index: 1,
      status: 'scheduled',
    });

    // A slip of theirs, registered and rejected: its state and reason, theirs only.
    const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:slip:${l.scheduleId}`,
      scheduleId: l.scheduleId,
      amountRial: 1_000_000n,
      receivedAt: new Date(),
      reference: 'TRK-SELF-1',
      paidOn: '2026-10-01',
      channel: 'manual_receipt',
    });
    await repayment.rejectPayment(
      CLI_ACTOR,
      paymentId,
      'رسید خوانا نیست',
      undefined,
      'received_unaccepted',
    );
    const slips = await mine(l.patient, `/me/repayment/schedules/${l.scheduleId}/payments`);
    expect(slips.status).toBe(200);
    expect((slips.body as Body[])[0]).toMatchObject({
      id: paymentId,
      bankRef: 'TRK-SELF-1',
      status: 'rejected',
      rejectReason: 'رسید خوانا نیست',
    });

    // Another patient: nothing of it (rule 13).
    const other = await w.patient();
    const theirs = await mine(
      other,
      `/me/repayment/schedules?creditApplicationId=${l.applicationId}`,
    );
    expect([theirs.status, theirs.body]).toEqual([200, []]);
    expect((await mine(other, `/me/repayment/schedules/${l.scheduleId}/payments`)).status).toBe(
      404,
    );
    // Staff do not use the self-service routes.
    expect(
      (await w.staff(advisor, 'GET', `/me/repayment/schedules/${l.scheduleId}/payments`)).status,
    ).toBe(403);
  });
});

describe('instruments by their owner and for the collection agent (task 6-9)', () => {
  it('the owner sees their own by the last four only; the agent sees a case’s held cheques; others refused', async () => {
    const l = await loan();
    const delivery = await w.staff(w.completion, 'POST', '/deliveries', {
      creditApplicationId: l.applicationId,
      items: [{ kind: 'cheque', label: 'چک ضمانت' }],
    });
    const deliveryId = delivery.body['id'] as string;
    const itemId = (delivery.body['items'] as Body[])[0]?.['id'] as string;
    await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/receive`, {
      method: 'in_person',
    });
    await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/items/${itemId}`, {
      status: 'received',
    });
    const number = `6037${String(Date.now()).slice(-12)}`;
    const cheque = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/instruments`, {
      itemId,
      kind: 'cheque',
      issuer: { role: 'borrower' },
      amountRial: '5000000',
      dueOn: '2026-12-01',
      number,
    });
    const instrumentId = cheque.body['id'] as string;
    await w.staff(w.completion, 'POST', `/instruments/${instrumentId}/sayad`);
    await w.staff(w.completion, 'POST', `/instruments/${instrumentId}/verify`);
    await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/check`);
    await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/archive`, {
      location: 'قفسه ۶-۹',
    });

    const own = await mine(l.patient, '/me/instruments');
    expect(own.status).toBe(200);
    expect((own.body as Body[]).find((i) => i['id'] === instrumentId)).toMatchObject({
      kind: 'cheque',
      role: 'borrower',
      numberLast4: number.slice(-4),
      status: 'held',
    });
    expect(JSON.stringify(own.body)).not.toContain(number);
    const other = await w.patient();
    expect(
      ((await mine(other, '/me/instruments')).body as Body[]).map((i) => i['id']),
    ).not.toContain(instrumentId);

    const candidates = await w.staff(
      agent,
      'GET',
      `/instrument-executions/candidates?caseId=${l.purse.caseId}`,
    );
    expect(candidates.status).toBe(200);
    expect(candidates.body as unknown as Body[]).toEqual([
      expect.objectContaining({
        instrumentId,
        numberLast4: number.slice(-4),
        amountRial: '5000000',
      }),
    ]);
    expect(JSON.stringify(candidates.body)).not.toContain(number);
    expect(
      (await w.staff(advisor, 'GET', `/instrument-executions/candidates?caseId=${l.purse.caseId}`))
        .status,
    ).toBe(403);
  });
});

describe('the collection manager’s proposals; the SMS record (task 6-9)', () => {
  it('a stage 3 proposal is listed for the manager, not for the agent; a staff-scheduled SMS is marked', async () => {
    const l = await loan();
    const s = await repayment.schedule(l.scheduleId);
    const third = s.installments[2]?.dueOn ?? '';
    const late = new Date(`${third}T08:30:00Z`);
    late.setUTCDate(late.getUTCDate() + 65);
    await collection.runCycle(CLI_ACTOR, late);
    const { rows } = await h.owner.query<Body>(
      `SELECT id FROM collection_tasks WHERE case_id = $1 AND stage = 3`,
      [l.purse.caseId],
    );
    const taskId = rows[0]?.['id'] as string;
    expect(taskId).toBeDefined();
    const proposed = await w.staff(agent, 'POST', `/collection/tasks/${taskId}/propose`, {
      reason: 'پیشنهاد اجرای چک',
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBeLessThan(300);
    const list = await w.staff(manager, 'GET', '/collection/tasks/proposed');
    expect(list.status).toBe(200);
    expect((list.body as unknown as Body[]).find((t) => t['taskId'] === taskId)).toMatchObject({
      stage: 3,
      kind: 'suggest_cheque',
      proposedBy: agent.id,
      proposalNote: 'پیشنهاد اجرای چک',
    });
    expect((await w.staff(agent, 'GET', '/collection/tasks/proposed')).status).toBe(403);

    // The SMS record: what staff scheduled is marked (cancellable), others are not.
    const template = await w.staff(
      await role('strategy_manager'),
      'POST',
      '/notification/sms-templates',
      {
        code: 'test.staff_note',
        audience: 'staff',
        category: 'transactional',
        body: 'جلسه {{count}}',
        reason: 'آزمون',
      },
    );
    expect(template.status).toBe(201);
    const scheduled = await w.staff(support, 'POST', '/notification/scheduled-sms', {
      templateCode: 'test.staff_note',
      mobile: '09121234567',
      values: { count: '۲' },
      sendAt: { date: '1406/01/15', time: '10:00' },
      reason: 'یادآوری جلسه',
    });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
    const record = await w.staff(support, 'GET', '/notification/sms-dispatches');
    const rowsOf = record.body as unknown as Body[];
    expect(rowsOf.find((d) => d['id'] === scheduled.body['dispatchId'])?.['staffScheduled']).toBe(
      true,
    );
    expect(
      rowsOf
        .filter((d) => d['id'] !== scheduled.body['dispatchId'])
        .every((d) => d['staffScheduled'] === false),
    ).toBe(true);
  });
});
