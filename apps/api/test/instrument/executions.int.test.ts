import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import type { Actor } from '../../src/common/audit/audit.port';
import { writeSheet } from '../../src/common/xlsx';
import { CollectionService } from '../../src/modules/collection/collection.service';
import { DownPaymentReconciliation } from '../../src/modules/contract/down-payment-reconciliation';
import { InstrumentExecutionService } from '../../src/modules/instrument/execution.service';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { WorkerModule } from '../../src/worker.module';
import {
  call,
  grantRole,
  loggedInAccount,
  newIp,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 6-8 [مالی] (doc 15 §6, §9 tests 12 and 14; owner 1405/07/16): a cheque proposed by the
 * collection agent and approved by the collection manager and finance, three people; cleared
 * through 6-2's own receipt and allocation (never more than owed, nothing to suspense);
 * bounced to stage 4 and legal action; released after full settlement by accounting. The
 * ledger stays balanced and the nightly reconciliations clean; the number never leaves.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let steps: ReturnType<typeof fundingSteps>;
let worker: INestApplicationContext | undefined;
let executions: InstrumentExecutionService;
let repayment: RepaymentService;
let wallet: WalletService;
let collection: CollectionService;
let agent: LoggedInAccount;
let manager: LoggedInAccount;
let finance: LoggedInAccount;
/** ADR-052: the second accountant, who approves a release the first asked for. */
let finance2: LoggedInAccount;
let both: LoggedInAccount;
/** Owner 1405/08/03: who asks for a release (release_requester); accounting only approves. */
let requester: LoggedInAccount;
let requester2: LoggedInAccount;
/** One person given both roles: still never decides their own request. */
let bothRelease: LoggedInAccount;
let advisor: LoggedInAccount;

const role = async (...codes: string[]) => {
  const who = await loggedInAccount(h, 'staff');
  for (const code of codes) await grantRole(h, who.id, code);
  return who;
};

const askRelease = (who: LoggedInAccount, instrumentId: string, reason = 'تسویه کامل') =>
  w.staff(who, 'POST', `/instrument-releases/${instrumentId}/requests`, { reason });
const decideRelease = (who: LoggedInAccount, requestId: string, outcome: 'approved' | 'refused') =>
  w.staff(who, 'POST', `/instrument-releases/requests/${requestId}/decision`, {
    outcome,
    ...(outcome === 'refused' ? { reason: 'مدرک ناقص' } : {}),
  });

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  // Owner 1405/07/27: promissory notes are off by default (0096); these tests keep the
  // path working for when the flag is turned on.
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('instrument.promissory_enabled', 'global', 'true', now(), 'approved', 'آزمون', now())`,
  );
  w = await creditWorld(h);
  steps = fundingSteps(h, w, {
    manager: await w.role('credit_manager'),
    finance: await w.role('accounting'),
  });
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
  executions = h.app.get(InstrumentExecutionService);
  repayment = h.app.get(RepaymentService);
  wallet = h.app.get(WalletService);
  collection = h.app.get(CollectionService);
  agent = await role('collection');
  manager = await role('collection_manager');
  finance = await role('accounting');
  finance2 = await role('accounting');
  both = await role('collection_manager', 'accounting');
  requester = await role('release_requester');
  requester2 = await role('release_requester');
  bothRelease = await role('release_requester', 'accounting');
  advisor = await role('advisor');
  // The collection queue's engine needs someone to assign to (6-7).
  const strategy = await role('strategy_manager');
  const shares = await w.staff(strategy, 'PUT', '/lead/assignment/shares', {
    queueCode: 'collection',
    shares: [{ accountId: agent.id, percent: 100 }],
    reason: 'سهم صف وصول',
  });
  expect(shares.status).toBe(200);
}, 240_000);

afterAll(async () => {
  await worker?.close();
  await h.close();
});

const as = async (who: LoggedInAccount) => ({
  actor: { ...CLI_ACTOR, accountId: who.id } as Actor,
  access: await h.app.get<AccessPort>(ACCESS_PORT).resolve(who.id),
});

let serial = 0;
/** A cheque number of 16 digits, unique; its full form must never leave the module. */
const chequeNumber = () =>
  `6037${String(Date.now()).slice(-8)}${String(++serial).padStart(4, '0')}`;

/** A funded loan; a second delivery brings a cheque (or a note), checked and archived: held. */
async function loanWithInstrument(
  opts: {
    amount?: (outstandingRial: bigint, firstRial: bigint) => bigint;
    kind?: 'cheque' | 'promissory_note';
    dueOffsetDays?: number;
  } = {},
) {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const purse = await wallet.summary(purseId);
  const [scheduleId] = await repayment.schedulesOf(purse.caseId);
  const schedule = await repayment.schedule(scheduleId ?? '');
  const first = schedule.installments[0];
  const kind = opts.kind ?? 'cheque';
  const number = chequeNumber();
  const delivery = await w.staff(w.completion, 'POST', '/deliveries', {
    creditApplicationId: applicationId,
    items: [{ kind, label: kind === 'cheque' ? 'چک ضمانت' : 'سفته' }],
  });
  expect(delivery.status, JSON.stringify(delivery.body)).toBe(201);
  const deliveryId = delivery.body['id'] as string;
  const itemId = (delivery.body['items'] as Body[])[0]?.['id'] as string;
  await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/receive`, { method: 'in_person' });
  await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/items/${itemId}`, {
    status: 'received',
  });
  const dueOn = new Date(`${first?.dueOn ?? ''}T00:00:00Z`);
  dueOn.setUTCDate(dueOn.getUTCDate() + (opts.dueOffsetDays ?? 0));
  const registered = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/instruments`, {
    itemId,
    kind,
    issuer: { role: 'borrower' },
    amountRial: String(
      (opts.amount ?? ((_, firstRial) => firstRial))(
        schedule.outstandingRial,
        first?.amountRial ?? 0n,
      ),
    ),
    dueOn: dueOn.toISOString().slice(0, 10),
    bankName: 'بانک ملی',
    number,
  });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const instrumentId = registered.body['id'] as string;
  if (kind === 'cheque') await w.staff(w.completion, 'POST', `/instruments/${instrumentId}/sayad`);
  expect(
    (await w.staff(w.completion, 'POST', `/instruments/${instrumentId}/verify`)).status,
  ).toBeLessThan(300);
  expect(
    (await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/check`)).body['status'],
  ).toBe('verified');
  const archived = await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/archive`, {
    location: 'قفسه ۶-۸',
  });
  expect(archived.body['status']).toBe('archived');
  return {
    patient,
    applicationId,
    purse,
    scheduleId: scheduleId ?? '',
    schedule,
    instrumentId,
    deliveryId,
    number,
  };
}
type Loan = Awaited<ReturnType<typeof loanWithInstrument>>;

/** Noon in Tehran, `days` after a YYYY-MM-DD day. */
function at(day: string, days: number): Date {
  const d = new Date(`${day}T08:30:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const instrumentStatus = async (id: string) =>
  (await h.owner.query<Row>('SELECT status FROM instruments WHERE id = $1', [id])).rows[0]?.[
    'status'
  ];

const counts = async () =>
  (
    await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM journal_entries) AS journals,
              (SELECT count(*)::int FROM payment_allocations) AS allocations,
              (SELECT count(*)::int FROM payments) AS payments`,
    )
  ).rows[0];

/** Doc 15 test 14: every journal balanced; the nightly reconciliations clean. */
async function sound() {
  const { rows } = await h.owner.query<Row>(
    `SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
     HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE -amount_rial END) <> 0`,
  );
  expect(rows).toEqual([]);
  const ctx = worker as INestApplicationContext;
  expect(await ctx.get(LedgerReconciliation).run()).toMatchObject({ clean: true });
  expect(await ctx.get(DownPaymentReconciliation).run()).toMatchObject({ clean: true });
}

/** Proposed by the agent, approved by the manager then finance: presented. */
async function present(l: Loan, now: Date) {
  const a = await as(agent);
  const proposed = await executions.propose(
    a.actor,
    a.access,
    { instrumentId: l.instrumentId, reason: 'معوق و سررسید چک رسیده' },
    now,
  );
  const m = await as(manager);
  await executions.approve(m.actor, m.access, proposed.id, {}, now);
  const f = await as(finance);
  const presented = await executions.approve(f.actor, f.access, proposed.id, {}, now);
  expect(presented.status).toBe('presented');
  return presented.id;
}

describe('executing a cheque (task 6-8)', () => {
  it('doc 15 test 12: three different people; presented, cleared through 6-2 (allocated, nothing to suspense); test 14', async () => {
    const l = await loanWithInstrument();
    const due = l.schedule.installments[0]?.dueOn ?? '';
    const late = at(due, 5);
    await sound();

    const a = await as(agent);
    // Not yet overdue: refused.
    await expect(
      executions.propose(
        a.actor,
        a.access,
        { instrumentId: l.instrumentId, reason: 'زود' },
        at(due, -1),
      ),
    ).rejects.toMatchObject({ response: { error: 'not_due' } });
    const proposed = await executions.propose(
      a.actor,
      a.access,
      { instrumentId: l.instrumentId, reason: 'معوق' },
      late,
    );
    expect(proposed).toMatchObject({ status: 'proposed', numberLast4: l.number.slice(-4) });
    // A second proposal of the same cheque: refused.
    await expect(
      executions.propose(
        a.actor,
        a.access,
        { instrumentId: l.instrumentId, reason: 'دوباره' },
        late,
      ),
    ).rejects.toMatchObject({ response: { error: 'execution_open' } });

    // The agent may not approve; one person may not give both approvals.
    expect(
      (await w.staff(agent, 'POST', `/instrument-executions/${proposed.id}/approve`, {})).status,
    ).toBe(403);
    const b = await as(both);
    await expect(
      executions.approve(b.actor, b.access, proposed.id, {}, late),
    ).rejects.toMatchObject({
      response: { error: 'approval_role_required' },
    });
    await executions.approve(b.actor, b.access, proposed.id, { as: 'collection' }, late);
    await expect(
      executions.approve(b.actor, b.access, proposed.id, { as: 'finance' }, late),
    ).rejects.toMatchObject({
      response: { error: 'same_person' },
    });
    // Nor does the database let one person sign twice.
    await expect(
      h.owner.query(
        `UPDATE instrument_executions SET finance_approved_by = collection_approved_by WHERE id = $1`,
        [proposed.id],
      ),
    ).rejects.toThrow();
    expect(await instrumentStatus(l.instrumentId)).toBe('held');
    const f = await as(finance);
    const presented = await executions.approve(f.actor, f.access, proposed.id, {}, late);
    expect(presented.status).toBe('presented');
    expect(await instrumentStatus(l.instrumentId)).toBe('presented');

    // Cleared: one receipt by the instrument's key, approved, allocated to the oldest.
    const before = await counts();
    const bankRef = `TRK${String(Date.now()).slice(-7)}`;
    const cleared = await executions.cleared(
      f.actor,
      f.access,
      proposed.id,
      { clearedOn: due, bankRef },
      late,
    );
    expect(cleared).toMatchObject({ status: 'cleared' });
    expect(await instrumentStatus(l.instrumentId)).toBe('cleared');
    const { rows: pay } = await h.owner.query<Row>(
      'SELECT status, channel, reference, amount_rial::text AS amount FROM payments WHERE id = $1',
      [cleared.paymentId],
    );
    expect(pay[0]).toMatchObject({
      status: 'approved',
      channel: 'bank_statement',
      reference: bankRef,
    });
    const after = await counts();
    expect(after?.['payments']).toBe((before?.['payments'] as number) + 1);
    const s = await repayment.schedule(l.scheduleId, late);
    expect(s.installments[0]?.status).toBe('paid');
    const { rows: suspense } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = $1 AND installment_id IS NULL`,
      [cleared.paymentId],
    );
    expect(suspense[0]?.['n'] ?? 0).toBe(0);
    // Again: refused; no second payment.
    await expect(
      executions.cleared(f.actor, f.access, proposed.id, { clearedOn: due, bankRef }, late),
    ).rejects.toMatchObject({ response: { error: 'execution_not_presented' } });
    expect((await counts())?.['payments']).toBe(after?.['payments']);
    await sound();

    // The full number nowhere: audit, events, SMS.
    const { rows: leak } = await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM audit_events WHERE before::text LIKE $1 OR after::text LIKE $1) AS audit,
              (SELECT count(*)::int FROM outbox_events WHERE payload::text LIKE $1) AS events,
              (SELECT count(*)::int FROM sms_dispatches WHERE text LIKE $1) AS sms`,
      [`%${l.number}%`],
    );
    expect(leak[0]).toEqual({ audit: 0, events: 0, sms: 0 });
  }, 600_000);

  it('owner ۶: the bank line of a cleared cheque (its tracking number and amount) is labelled «related to a cheque»; a slip of the same deposit gets 6-2’s duplicate warning', async () => {
    const l = await loanWithInstrument();
    const due = l.schedule.installments[0]?.dueOn ?? '';
    const late = at(due, 5);
    const id = await present(l, late);
    const f = await as(finance);
    const bankRef = `CHQ${String(Date.now()).slice(-7)}`;
    const cleared = await executions.cleared(
      f.actor,
      f.access,
      id,
      { clearedOn: due, bankRef },
      late,
    );
    const amount = String(l.schedule.installments[0]?.amountRial ?? 0n);

    // The bank statement: the same tracking number and amount, and an unrelated deposit.
    const file = writeSheet([
      ['تاریخ', 'مبلغ', 'پیگیری', 'شرح'],
      ['1405/07/20', amount, bankRef, 'وصول چک'],
      ['1405/07/20', '123000', `OTHER${String(Date.now()).slice(-5)}`, 'واریز دیگر'],
    ]);
    const form = new FormData();
    form.append(
      'map',
      JSON.stringify({
        dateColumn: 0,
        amountColumn: 1,
        refColumn: 2,
        descriptionColumn: 3,
        amountUnit: 'rial',
        headerRow: true,
      }),
    );
    form.append('file', new Blob([new Uint8Array(file)]), 'statement.xlsx');
    const imported = await fetch(`${h.baseUrl}/repayment/bank-statements`, {
      method: 'POST',
      headers: { authorization: `Bearer ${finance.access}`, 'x-forwarded-for': newIp() },
      body: form,
    });
    const importBody = (await imported.json()) as Body;
    expect(imported.status, JSON.stringify(importBody)).toBe(201);
    const rows = (await (
      await fetch(`${h.baseUrl}/repayment/bank-statements/${importBody['id'] as string}/rows`, {
        headers: { authorization: `Bearer ${finance.access}`, 'x-forwarded-for': newIp() },
      })
    ).json()) as Body[];
    expect(
      rows.map((r) => [r['matchKind'], r['suggestedPaymentId'], r['relatedToCheque']]),
    ).toEqual([
      ['exact', cleared.paymentId, true],
      ['none', null, false],
    ]);

    // A slip of the same deposit entered again: 6-2 flags it as the cheque's twin, unchanged.
    const before = await counts();
    const slip = await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:slip:${randomUUID()}`,
      scheduleId: l.scheduleId,
      amountRial: BigInt(amount),
      receivedAt: new Date(),
      reference: bankRef,
      paidOn: due,
      channel: 'manual_receipt',
    });
    const { rows: twin } = await h.owner.query<Row>(
      'SELECT suspected_duplicate_of, status FROM payments WHERE id = $1',
      [slip.paymentId],
    );
    expect(twin[0]).toEqual({
      suspected_duplicate_of: cleared.paymentId,
      status: 'pending_approval',
    });
    // Approving it takes 6-2's explicit decision, as for any other twin.
    await expect(repayment.approvePayment(CLI_ACTOR, slip.paymentId)).rejects.toMatchObject({
      response: { error: 'suspected_duplicate' },
    });
    expect((await counts())?.['allocations']).toBe(before?.['allocations']);
    await sound();
  }, 600_000);

  it('owner ۴: larger than what is owed is refused when proposed; owed less by clearance: presented still, two alerts, nothing posted', async () => {
    const big = await loanWithInstrument({ amount: (owed) => owed + 1n });
    const due = big.schedule.installments[0]?.dueOn ?? '';
    const a = await as(agent);
    await expect(
      executions.propose(
        a.actor,
        a.access,
        { instrumentId: big.instrumentId, reason: 'بزرگ' },
        at(due, 5),
      ),
    ).rejects.toMatchObject({ response: { error: 'exceeds_outstanding' } });

    // A cheque of exactly the whole debt, presented; then the borrower pays a part.
    const l = await loanWithInstrument({ amount: (owed) => owed });
    const late = at(l.schedule.installments[0]?.dueOn ?? '', 5);
    const id = await present(l, late);
    const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId: l.scheduleId,
      amountRial: 1_000n,
      receivedAt: new Date(),
    });
    await repayment.approvePayment(CLI_ACTOR, paymentId);
    const before = await counts();
    const f = await as(finance);
    await expect(
      executions.cleared(
        f.actor,
        f.access,
        id,
        { clearedOn: '2026-11-01', bankRef: 'TRK-BIG-1' },
        late,
      ),
    ).rejects.toMatchObject({ response: { error: 'exceeds_outstanding' } });
    expect(await counts()).toEqual(before);
    expect(await instrumentStatus(l.instrumentId)).toBe('presented');
    const { rows: notices } = await h.owner.query<Row>(
      `SELECT audience_permission, message FROM admin_notices
       WHERE code IN ('instrument_clearance_exceeds_collection', 'instrument_clearance_exceeds_finance')
         AND resolved_at IS NULL ORDER BY 1`,
    );
    expect(notices.every((n) => (n['message'] as string).includes(id))).toBe(true);
    expect(notices.map((n) => n['audience_permission'])).toEqual([
      'instrument.approve_execution_collection',
      'instrument.approve_execution_finance',
    ]);
    // Seen by the collection manager and by finance, in their own alert list (live).
    for (const who of [manager, finance]) {
      const seen = await w.staff(who, 'GET', '/instrument-executions/alerts');
      expect(seen.status).toBe(200);
      expect((seen.body as unknown as Body[]).find((r) => r['executionId'] === id)).toMatchObject({
        instrumentId: l.instrumentId,
        numberLast4: l.number.slice(-4),
      });
      expect(JSON.stringify(seen.body)).not.toContain(l.number);
    }
    expect((await w.staff(agent, 'GET', '/instrument-executions/alerts')).status).toBe(403);
    // Bounced instead (the bank refused it after all): the alert and the notices go.
    await executions.bounced(f.actor, f.access, id, {
      bouncedOn: '2026-11-01',
      reason: 'other',
      note: 'بانک برگشت زد',
    });
    expect((await executions.alerts(f.access, late)).map((r) => r.executionId)).not.toContain(id);
    await sound();
  }, 600_000);

  it('bounced: nothing posted; stage 4 for the collection manager; decided, the cheque goes to legal action', async () => {
    const l = await loanWithInstrument();
    const due = l.schedule.installments[0]?.dueOn ?? '';
    const late = at(due, 5);
    await collection.runCycle(CLI_ACTOR, late);
    const id = await present(l, late);
    const before = await counts();
    const f = await as(finance);
    const bounced = await executions.bounced(f.actor, f.access, id, {
      bouncedOn: due,
      reason: 'insufficient_funds',
    });
    expect(bounced.status).toBe('bounced');
    expect(await instrumentStatus(l.instrumentId)).toBe('bounced');
    expect(await counts()).toEqual(before);
    const { rows: tasks } = await h.owner.query<Row>(
      `SELECT id, status FROM collection_tasks WHERE case_id = $1 AND stage = 4 AND kind = 'legal_referral'`,
      [l.purse.caseId],
    );
    expect(tasks).toHaveLength(1);
    const taskId = tasks[0]?.['id'] as string;
    const proposedTask = await w.staff(agent, 'POST', `/collection/tasks/${taskId}/propose`, {
      reason: 'ارجاع حقوقی',
    });
    expect(proposedTask.status, JSON.stringify(proposedTask.body)).toBeLessThan(300);
    const decided = await w.staff(manager, 'POST', `/collection/tasks/${taskId}/decide`, {
      decision: 'done',
      note: 'ارجاع شد',
    });
    expect(decided.status, JSON.stringify(decided.body)).toBeLessThan(300);
    expect(await instrumentStatus(l.instrumentId)).toBe('legal_action');
    expect(await counts()).toEqual(before);
    await sound();
  }, 600_000);

  it('owner ۵: a promissory note is only referred to legal; a cheque not yet due or a loan not overdue is refused', async () => {
    const note = await loanWithInstrument({ kind: 'promissory_note' });
    const late = at(note.schedule.installments[0]?.dueOn ?? '', 5);
    const a = await as(agent);
    await expect(
      executions.propose(
        a.actor,
        a.access,
        { instrumentId: note.instrumentId, reason: 'سفته' },
        late,
      ),
    ).rejects.toMatchObject({ response: { error: 'promissory_legal_only' } });
    const future = await loanWithInstrument({ dueOffsetDays: 60 });
    await expect(
      executions.propose(
        a.actor,
        a.access,
        { instrumentId: future.instrumentId, reason: 'آینده' },
        at(future.schedule.installments[0]?.dueOn ?? '', 5),
      ),
    ).rejects.toMatchObject({ response: { error: 'not_due' } });
    const early = await loanWithInstrument({ dueOffsetDays: -40 });
    await expect(
      executions.propose(
        a.actor,
        a.access,
        { instrumentId: early.instrumentId, reason: 'زود' },
        at(early.schedule.installments[0]?.dueOn ?? '', -1),
      ),
    ).rejects.toMatchObject({ response: { error: 'not_overdue' } });
  }, 600_000);
});

describe('release after full settlement (task 6-8)', () => {
  it('doc 15 test 12: before full settlement 409; after it, a live queue; released with its delivery; an SMS by name only', async () => {
    const l = await loanWithInstrument();
    const refused = await askRelease(requester, l.instrumentId);
    expect([refused.status, refused.body['error']]).toEqual([409, 'not_settled']);
    const due = await w.staff(finance, 'GET', '/instrument-releases/due');
    expect((due.body as unknown as Body[]).map((r) => r['instrumentId'])).not.toContain(
      l.instrumentId,
    );

    // Everything paid (6-2's own path): settled.
    const owed = (await repayment.schedule(l.scheduleId)).outstandingRial;
    const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId: l.scheduleId,
      amountRial: owed,
      receivedAt: new Date(),
    });
    await repayment.approvePayment(CLI_ACTOR, paymentId);
    const listed = await w.staff(finance, 'GET', '/instrument-releases/due');
    const row = (listed.body as unknown as Body[]).find(
      (r) => r['instrumentId'] === l.instrumentId,
    );
    expect(row).toMatchObject({ caseId: l.purse.caseId, numberLast4: l.number.slice(-4) });
    expect(JSON.stringify(listed.body)).not.toContain(l.number);
    expect((await askRelease(agent, l.instrumentId)).status).toBe(403);

    const before = await counts();
    // ADR-052: asked by the requester, released when accounting approves.
    const asked = await askRelease(requester, l.instrumentId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(await instrumentStatus(l.instrumentId)).toBe('held');
    const decided = await decideRelease(finance2, asked.body['id'] as string, 'approved');
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const released = { body: decided.body['release'] as Body };
    expect(released.body).toMatchObject({
      status: 'released',
      deliveryReleased: true,
      smsSent: true,
    });
    expect(await instrumentStatus(l.instrumentId)).toBe('released');
    const { rows: d } = await h.owner.query<Row>(
      'SELECT status FROM physical_deliveries WHERE id = $1',
      [l.deliveryId],
    );
    expect(d[0]?.['status']).toBe('released');
    const { rows: sms } = await h.owner.query<Row>(
      `SELECT d.text, t.code FROM instrument_releases r JOIN sms_dispatches d ON d.id = r.sms_dispatch_id
       JOIN sms_templates t ON t.id = d.template_id WHERE r.instrument_id = $1`,
      [l.instrumentId],
    );
    expect(sms[0]?.['code']).toBe('instrument.release_ready_borrower');
    expect(sms[0]?.['text']).toMatch(/مدرک ضمانت شما آماده تحویل است/);
    expect(sms[0]?.['text']).not.toMatch(/[0-9۰-۹]/);
    // Released once; nothing posted by it.
    expect((await askRelease(requester, l.instrumentId)).status).toBe(409);
    expect(await counts()).toEqual(before);
    await sound();
  }, 600_000);
});

describe('ADR-052: a release is two people, each with their own SMS code', () => {
  /** A held instrument of a loan paid in full: ready to release. */
  async function settled() {
    const l = await loanWithInstrument();
    const owed = (await repayment.schedule(l.scheduleId)).outstandingRial;
    const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:receipt:${randomUUID()}`,
      scheduleId: l.scheduleId,
      amountRial: owed,
      receivedAt: new Date(),
    });
    await repayment.approvePayment(CLI_ACTOR, paymentId);
    return l;
  }

  it('one person never asks and approves; the database refuses it too; refused or withdrawn, it stays held', async () => {
    const l = await settled();
    const asked = await askRelease(bothRelease, l.instrumentId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const requestId = asked.body['id'] as string;
    // A second request while one waits: refused.
    expect((await askRelease(requester, l.instrumentId)).body['error']).toBe('release_requested');
    const self = await decideRelease(bothRelease, requestId, 'approved');
    expect([self.status, self.body['error']]).toEqual([403, 'second_person_required']);
    await expect(
      h.owner.query(
        `INSERT INTO instrument_release_decisions (request_id, outcome, decided_by)
         VALUES ($1, 'approved', $2)`,
        [requestId, bothRelease.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const due = await w.staff(finance2, 'GET', '/instrument-releases/due');
    expect(
      (due.body as unknown as Body[]).find((r) => r['instrumentId'] === l.instrumentId),
    ).toMatchObject({ pendingRequest: { id: requestId, requestedBy: bothRelease.id } });

    const refused = await decideRelease(finance2, requestId, 'refused');
    expect(refused.body).toMatchObject({ outcome: 'refused', release: null });
    expect(await instrumentStatus(l.instrumentId)).toBe('held');
    expect((await decideRelease(finance, requestId, 'approved')).body['error']).toBe(
      'release_request_closed',
    );

    const again = await askRelease(requester, l.instrumentId);
    const againId = again.body['id'] as string;
    expect(
      (await w.staff(requester2, 'POST', `/instrument-releases/requests/${againId}/withdraw`)).body[
        'error'
      ],
    ).toBe('not_your_request');
    const withdrawn = await w.staff(
      requester,
      'POST',
      `/instrument-releases/requests/${againId}/withdraw`,
    );
    expect(withdrawn.body).toMatchObject({ outcome: 'withdrawn' });
    expect(await instrumentStatus(l.instrumentId)).toBe('held');
    expect(
      (
        await h.owner.query<Row>(
          'SELECT count(*)::int AS n FROM instrument_releases WHERE instrument_id = $1',
          [l.instrumentId],
        )
      ).rows[0]?.['n'],
    ).toBe(0);
  }, 600_000);

  it('owner 1405/08/03: no role both asks for a release and approves it; accounting only approves', async () => {
    const { rows } = await h.owner.query<Row>(
      `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.deleted_at IS NULL AND r.deleted_at IS NULL
          AND rp.permission_code IN ('instrument.request_release', 'instrument.approve_release')
        GROUP BY r.code HAVING count(DISTINCT rp.permission_code) = 2`,
    );
    expect(rows).toEqual([]);
    const holders = async (code: string) =>
      (
        await h.owner.query<Row>(
          `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
            WHERE rp.deleted_at IS NULL AND rp.permission_code = $1 ORDER BY r.code`,
          [code],
        )
      ).rows.map((r) => r['code']);
    expect(await holders('instrument.request_release')).toEqual(['release_requester']);
    expect(await holders('instrument.approve_release')).toEqual(['accounting']);
    const l = await settled();
    expect((await askRelease(finance, l.instrumentId)).status).toBe(403);
  }, 600_000);

  it('no direct way round: the old one-person route is gone; no code, no release', async () => {
    const l = await settled();
    expect((await w.staff(finance, 'POST', `/instrument-releases/${l.instrumentId}`)).status).toBe(
      404,
    );
    const noCode = await call(h, 'POST', `/instrument-releases/${l.instrumentId}/requests`, {
      bearer: requester.access,
      body: { reason: 'بی کد' },
      stepUp: false,
    });
    expect([noCode.status, noCode.body['error']]).toEqual([403, 'step_up_required']);
    const asked = await askRelease(requester, l.instrumentId);
    const approve = await call(
      h,
      'POST',
      `/instrument-releases/requests/${asked.body['id'] as string}/decision`,
      { bearer: finance2.access, body: { outcome: 'approved' }, stepUp: false },
    );
    expect([approve.status, approve.body['error']]).toEqual([403, 'step_up_required']);
    expect(await instrumentStatus(l.instrumentId)).toBe('held');
  }, 600_000);

  it('two approvals at once: released exactly once', async () => {
    const l = await settled();
    const asked = await askRelease(requester, l.instrumentId);
    const requestId = asked.body['id'] as string;
    const results = await Promise.all([
      decideRelease(finance2, requestId, 'approved'),
      decideRelease(both, requestId, 'approved'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await instrumentStatus(l.instrumentId)).toBe('released');
    expect(
      (
        await h.owner.query<Row>(
          'SELECT count(*)::int AS n FROM instrument_releases WHERE instrument_id = $1',
          [l.instrumentId],
        )
      ).rows[0]?.['n'],
    ).toBe(1);
  }, 600_000);
});

describe('access (task 6-8)', () => {
  it('without the permission 403; another scope finds nothing', async () => {
    expect((await w.staff(advisor, 'GET', '/instrument-executions')).status).toBe(403);
    expect(
      (
        await w.staff(advisor, 'POST', '/instrument-executions', {
          instrumentId: randomUUID(),
          reason: 'آزمون',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await w.staff(manager, 'POST', '/instrument-executions', {
          instrumentId: randomUUID(),
          reason: 'آزمون',
        })
      ).status,
    ).toBe(403);
    expect((await w.staff(advisor, 'GET', '/instrument-releases/due')).status).toBe(403);
    const ownAgent = await loggedInAccount(h, 'staff');
    await grantRole(h, ownAgent.id, 'collection', { kind: 'own' });
    expect((await w.staff(ownAgent, 'GET', '/instrument-executions')).status).toBe(404);
  });
});
