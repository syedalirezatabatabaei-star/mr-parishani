import { randomUUID } from 'node:crypto';
import { RequestMethod } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../src/common/credit/credit-contract-facts.port';
import {
  ASSIGNMENT_ENGINE,
  type AssignmentEngine,
} from '../../src/common/lead/assignment-engine.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { CollectionController } from '../../src/modules/collection/collection.controller';
import { CollectionService } from '../../src/modules/collection/collection.service';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import {
  grantRole,
  loggedInAccount,
  newIp,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, PDF, type Body, type Row } from '../credit/world';

/**
 * Task 6-7 (doc 15 §5, §9 tests 5 and 11; owner 1405/07/16): the overdue queue assigned by
 * 3-5's engine; actions, promises judged on their day; escalation only makes tasks (the
 * guarantor's SMS only by a person's decision; stage 3 and 4 by two people); a borrower's
 * deceased or disabled status by two people with a document, holding their automatic SMS.
 * The collection unit sees no treatment, doctor or center anywhere. Nothing posts.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let steps: ReturnType<typeof fundingSteps>;
let collection: CollectionService;
let repayment: RepaymentService;
let wallet: WalletService;
let agent: LoggedInAccount;
let otherAgent: LoggedInAccount;
let manager: LoggedInAccount;
let both: LoggedInAccount;
let strategy: LoggedInAccount;

const role = async (code: string, scope?: Parameters<typeof grantRole>[3]) => {
  const who = await loggedInAccount(h, 'staff');
  await grantRole(h, who.id, code, scope);
  return who;
};

async function setShares(shares: { accountId: string; percent: number }[]) {
  const res = await w.staff(strategy, 'PUT', '/lead/assignment/shares', {
    queueCode: 'collection',
    shares,
    reason: 'سهم صف وصول',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  const creditManager = await w.role('credit_manager');
  const finance = await w.role('accounting');
  steps = fundingSteps(h, w, { manager: creditManager, finance });
  collection = h.app.get(CollectionService);
  repayment = h.app.get(RepaymentService);
  wallet = h.app.get(WalletService);
  agent = await role('collection');
  otherAgent = await role('collection', { kind: 'own' });
  manager = await role('collection_manager');
  both = await role('collection');
  await grantRole(h, both.id, 'collection_manager');
  strategy = await role('strategy_manager');
  await setShares([{ accountId: agent.id, percent: 100 }]);
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** A funded loan: its case, schedule, purse, borrower and first installment. */
async function loan() {
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const purse = await wallet.summary(purseId);
  const [scheduleId] = await repayment.schedulesOf(purse.caseId);
  const s = await repayment.schedule(scheduleId ?? '');
  return {
    patient,
    applicationId,
    purseId,
    caseId: purse.caseId,
    borrowerPersonId: purse.borrowerPersonId,
    scheduleId: s.id,
    installments: s.installments,
  };
}
type Loan = Awaited<ReturnType<typeof loan>>;

/** Noon in Tehran, `days` from a YYYY-MM-DD day. */
function at(day: string, days: number): Date {
  const d = new Date(`${day}T08:30:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

const itemOf = async (caseId: string) =>
  (
    await h.owner.query<Row>(
      'SELECT id, assignee_account_id, closed_at, close_reason FROM collection_items WHERE case_id = $1 ORDER BY opened_at DESC LIMIT 1',
      [caseId],
    )
  ).rows[0];

const tasksOf = async (itemId: string) =>
  (
    await h.owner.query<Row>(
      'SELECT id, stage, kind, status FROM collection_tasks WHERE item_id = $1 ORDER BY stage, created_at',
      [itemId],
    )
  ).rows;

const counts = async () =>
  (
    await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM journal_entries) AS journals,
              (SELECT count(*)::int FROM payment_allocations) AS allocations`,
    )
  ).rows[0];

async function pay(l: Loan, amountRial: bigint) {
  const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
    idempotencyKey: `test:receipt:${randomUUID()}`,
    scheduleId: l.scheduleId,
    amountRial,
    receivedAt: new Date(),
  });
  await repayment.approvePayment(CLI_ACTOR, paymentId);
}

describe('the overdue queue (task 6-7)', () => {
  let l: Loan;
  let itemId: string;

  it('an overdue case opened once and assigned by the engine; stage 1 a task; nothing posted', async () => {
    l = await loan();
    const due = l.installments[0]?.dueOn ?? '';
    const before = await counts();
    await collection.runCycle(CLI_ACTOR, at(due, -1));
    expect(await itemOf(l.caseId)).toBeUndefined();
    await collection.runCycle(CLI_ACTOR, at(due, 5));
    await collection.runCycle(CLI_ACTOR, at(due, 5));
    const item = await itemOf(l.caseId);
    expect(item).toMatchObject({ assignee_account_id: agent.id, closed_at: null });
    itemId = item?.['id'] as string;
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM collection_items WHERE case_id = $1',
      [l.caseId],
    );
    expect(rows[0]?.['n']).toBe(1);
    expect((await tasksOf(itemId)).map((t) => [t['stage'], t['kind']])).toEqual([[1, 'call']]);
    expect(await counts()).toEqual(before);

    // The queue, the agent's own (over HTTP, today's clock: in it, not yet late today).
    const queue = await w.staff(agent, 'GET', '/collection/queue?mine=true');
    expect(queue.status).toBe(200);
    expect((queue.body as unknown as Body[]).find((r) => r['itemId'] === itemId)).toMatchObject({
      caseId: l.caseId,
      assigneeAccountId: agent.id,
    });
    // As of five days late: bucket 1-30 (index 0), one installment, its amount.
    const access = await h.app.get<AccessPort>(ACCESS_PORT).resolve(agent.id);
    const late = await collection.queue(
      { ...CLI_ACTOR, accountId: agent.id },
      access,
      { bucket: 0 },
      at(due, 5),
    );
    expect(late.find((r) => r.itemId === itemId)).toMatchObject({
      bucket: 0,
      maxDaysPastDue: 5,
      overdueInstallments: 1,
      overdueRial: (l.installments[0]?.amountRial ?? 0n).toString(),
    });
  });

  it('access: another agent (own scope) sees nothing of it; advisor and doctor are refused', async () => {
    expect(
      (await w.staff(otherAgent, 'GET', '/collection/queue')).body as unknown as Body[],
    ).toEqual([]);
    expect((await w.staff(otherAgent, 'GET', `/collection/items/${itemId}`)).status).toBe(404);
    expect(
      (
        await w.staff(otherAgent, 'POST', `/collection/items/${itemId}/actions`, {
          kind: 'call',
          outcome: 'پاسخ نداد',
          occurredAt: new Date().toISOString(),
        })
      ).status,
    ).toBe(404);
    const advisor = await role('advisor');
    expect((await w.staff(advisor, 'GET', '/collection/queue')).status).toBe(403);
    expect((await w.staff(w.doctor, 'GET', `/collection/items/${itemId}`)).status).toBe(403);
  });

  it('doc 15 test 11: a promise kept on its day, another broken (the agent told), one not yet due open; judged once', async () => {
    const due = l.installments[0]?.dueOn ?? '';
    const promise = async (amountRial: string, promisedOn: string) => {
      const res = await w.staff(agent, 'POST', `/collection/items/${itemId}/promises`, {
        amountRial,
        promisedOn,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body['id'] as string;
    };
    const keptId = await promise('100000', dayOf(at(due, 10)));
    const brokenId = await promise('900000000', dayOf(at(due, 10)));
    const laterId = await promise('100000', dayOf(at(due, 20)));
    // A part paid after the promises (still overdue): 100,000 rials.
    await pay(l, 100_000n);
    await collection.runCycle(CLI_ACTOR, at(due, 9));
    const status = async (id: string) =>
      (await h.owner.query<Row>('SELECT status FROM payment_promises WHERE id = $1', [id])).rows[0]?.[
        'status'
      ];
    expect(await status(keptId)).toBe('open');
    await collection.runCycle(CLI_ACTOR, at(due, 10));
    await collection.runCycle(CLI_ACTOR, at(due, 10));
    expect(await status(keptId)).toBe('kept');
    expect(await status(brokenId)).toBe('broken');
    expect(await status(laterId)).toBe('open');
    const broken = (await tasksOf(itemId)).filter((t) => t['kind'] === 'promise_broken');
    expect(broken).toHaveLength(1);
    // A promise for a day already past is refused.
    const past = await w.staff(agent, 'POST', `/collection/items/${itemId}/promises`, {
      amountRial: '1000',
      promisedOn: '2020-01-01',
    });
    expect(past.status).toBe(400);
    // Cancelled with a reason, once.
    const cancel = (id: string) =>
      w.staff(agent, 'POST', `/collection/promises/${id}/cancel`, { reason: 'وعده جدید داد' });
    expect((await cancel(laterId)).status).toBe(200);
    expect((await cancel(laterId)).status).toBe(409);
  });

  it('stage 2: a task only, no SMS by itself; sent by the agent’s decision, the guarantor’s fields only', async () => {
    const due = l.installments[0]?.dueOn ?? '';
    await collection.runCycle(CLI_ACTOR, at(due, 31));
    const task = (await tasksOf(itemId)).find((t) => t['kind'] === 'guarantor_notice');
    expect(task).toMatchObject({ stage: 2, status: 'open' });
    const key = `collection:guarantor:${itemId}:`;
    const sms = async () =>
      (
        await h.owner.query<Row>(
          'SELECT text, audience FROM sms_dispatches WHERE starts_with(idempotency_key, $1)',
          [key],
        )
      ).rows;
    expect(await sms()).toEqual([]);
    const taskId = task?.['id'] as string;
    // Done only by sending it.
    const worked = await w.staff(agent, 'POST', `/collection/tasks/${taskId}/work`, {
      outcome: 'done',
      note: 'ضامن مطلع شد',
    });
    expect(worked.status).toBe(409);

    // The loan's guarantor (credit's guarantor flow is tested there): a person with a mobile.
    const guarantor = await w.patient();
    const { rows: g } = await h.owner.query<Row>(
      'SELECT person_id FROM user_accounts WHERE id = $1',
      [guarantor.id],
    );
    const facts = h.app.get<CreditContractFactsPort>(CREDIT_CONTRACT_FACTS, { strict: false });
    const original = facts.facts.bind(facts);
    const spy = vi.spyOn(facts, 'facts').mockImplementation(async (id) => {
      const real = await original(id);
      return real && { ...real, guarantors: [{ id: randomUUID(), personId: g[0]?.['person_id'] as string }] };
    });
    try {
      const sent = await w.staff(agent, 'POST', `/collection/tasks/${taskId}/send-guarantor-sms`, {
        reason: 'سی روز معوق، تماس بی‌پاسخ',
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const texts = await sms();
      expect(texts).toHaveLength(1);
      expect(texts[0]?.['audience']).toBe('guarantor');
      for (const word of ['دندانپزشکی', 'جرم‌گیری', 'کلینیک اعتبار', 'دکتر اعتبار', 'dental']) {
        expect(texts[0]?.['text']).not.toContain(word);
      }
      expect(
        (await w.staff(agent, 'POST', `/collection/tasks/${taskId}/send-guarantor-sms`, {
          reason: 'دوباره',
        })).status,
      ).toBe(409);
    } finally {
      spy.mockRestore();
    }
    const { rows: actions } = await h.owner.query<Row>(
      `SELECT kind, outcome FROM collection_actions WHERE item_id = $1 AND kind = 'guarantor_contact'`,
      [itemId],
    );
    expect(actions).toEqual([{ kind: 'guarantor_contact', outcome: 'sms_sent' }]);
  });

  it('stage 3: proposed by the agent, decided by the collection manager, never the same person', async () => {
    const due = l.installments[0]?.dueOn ?? '';
    await collection.runCycle(CLI_ACTOR, at(due, 61));
    const task = (await tasksOf(itemId)).find((t) => t['kind'] === 'suggest_cheque');
    expect(task).toMatchObject({ stage: 3, status: 'open' });
    const taskId = task?.['id'] as string;
    const path = `/collection/tasks/${taskId}`;
    expect((await w.staff(agent, 'POST', `${path}/work`, { outcome: 'done', note: 'اجرا' })).status).toBe(409);
    expect((await w.staff(agent, 'POST', `${path}/decide`, { decision: 'done', note: 'اجرا' })).status).toBe(403);
    // One person holding both roles may not decide their own proposal.
    expect((await w.staff(both, 'POST', `${path}/propose`, { reason: 'پیشنهاد اجرای چک' })).status).toBe(200);
    const own = await w.staff(both, 'POST', `${path}/decide`, { decision: 'done', note: 'تأیید' });
    expect(own.status).toBe(409);
    expect(own.body['error']).toBe('same_person');
    const decided = await w.staff(manager, 'POST', `${path}/decide`, {
      decision: 'done',
      note: 'تأیید اجرای چک (اجرا در ۶-۸)',
    });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ status: 'done' });
  });

  it('doc 15 test 5: no treatment, doctor or center in any read, the CSV or an SMS preview', async () => {
    // Every GET route of the controller, from its metadata: none may be left untested.
    const proto = CollectionController.prototype as unknown as Record<string, unknown>;
    const gets = Object.getOwnPropertyNames(proto)
      .filter((m) => m !== 'constructor')
      .map((m) => proto[m] as object)
      .filter((fn) => Reflect.getMetadata('method', fn) === RequestMethod.GET)
      .map((fn) => Reflect.getMetadata('path', fn) as string)
      .sort();
    const pending = await w.staff(manager, 'GET', '/collection/borrower-status/pending');
    expect(pending.status).toBe(200);
    const calls: Record<string, string[]> = {
      queue: ['/collection/queue'],
      'queue.csv': ['/collection/queue.csv'],
      'items/:id': [`/collection/items/${itemId}`],
      'items/:id/sms-preview': [
        `/collection/items/${itemId}/sms-preview?audience=borrower`,
        `/collection/items/${itemId}/sms-preview?audience=guarantor`,
      ],
      'borrower-status/pending': ['/collection/borrower-status/pending'],
      // Task 6-9: the collection manager's proposals waiting for a decision.
      'tasks/proposed': ['/collection/tasks/proposed'],
    };
    expect(Object.keys(calls).sort()).toEqual(gets);
    const forbidden = ['دندانپزشکی', 'جرم‌گیری', 'کلینیک اعتبار', 'دکتر اعتبار', 'dental', 'scaling'];
    for (const [route, paths] of Object.entries(calls)) {
      for (const p of paths) {
        const who =
          route.startsWith('borrower-status') || route === 'tasks/proposed' ? manager : agent;
        const res = await fetch(`${h.baseUrl}${p}`, {
          headers: { authorization: `Bearer ${who.access}`, 'x-forwarded-for': newIp() },
        });
        expect(res.status, p).toBe(200);
        const text = await res.text();
        for (const word of forbidden) expect(text, `${p}: ${word}`).not.toContain(word);
        expect(text, p).not.toMatch(/"(treatment\w*|doctor\w*|center\w*|serviceCode)"\s*:/i);
        if (route === 'queue.csv') expect(text).toContain(itemId);
      }
    }
  });
});

describe('deceased or disabled (doc 15 §5; owner: two people, a document)', () => {
  it('proposed with a document, approved by another; the borrower’s reminders held; lifted the same way; nothing posted', async () => {
    const l = await loan();
    const due = l.installments[0]?.dueOn ?? '';
    await collection.runCycle(CLI_ACTOR, at(due, 3));
    const itemId = (await itemOf(l.caseId))?.['id'] as string;
    const before = await counts();
    const propose = async (who: LoggedInAccount, kind: string, file?: Buffer) => {
      const form = new FormData();
      form.append('itemId', itemId);
      form.append('kind', kind);
      form.append('note', 'گواهی فوت از ثبت احوال');
      if (file) form.append('file', new Blob([new Uint8Array(file)]), 'evidence.pdf');
      const res = await fetch(`${h.baseUrl}/collection/borrower-status`, {
        method: 'POST',
        headers: { authorization: `Bearer ${who.access}`, 'x-forwarded-for': newIp() },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as Body };
    };
    expect((await propose(agent, 'deceased')).status).toBe(400);
    expect((await propose(manager, 'deceased', PDF)).status).toBe(403);
    const proposed = await propose(both, 'deceased', PDF);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const id = proposed.body['id'] as string;
    // Not yet approved: not held; the proposer may not approve.
    expect(await collection.isHeld(l.borrowerPersonId)).toBe(false);
    const own = await w.staff(both, 'POST', `/collection/borrower-status/${id}/approve`);
    expect(own.status).toBe(409);
    expect((await w.staff(agent, 'POST', `/collection/borrower-status/${id}/approve`)).status).toBe(403);
    expect((await w.staff(manager, 'POST', `/collection/borrower-status/${id}/approve`)).status).toBe(200);
    expect(await collection.isHeld(l.borrowerPersonId)).toBe(true);

    // Task 6-6's reminders: none to a held borrower (the next installment, 3 days before).
    const next = l.installments[1];
    await repayment.runReminders(at(next?.dueOn ?? '', -3));
    const reminded = async () =>
      (
        await h.owner.query<Row>(
          'SELECT count(*)::int AS n FROM installment_reminders WHERE installment_id = $1',
          [next?.id],
        )
      ).rows[0]?.['n'];
    expect(await reminded()).toBe(0);
    const { rows: audit } = await h.owner.query<Row>(
      `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY seq`,
      [id],
    );
    expect(audit.map((a) => a['action'])).toEqual([
      'collection.borrower_status_proposed',
      'collection.borrower_status_approved',
    ]);

    // Lifted, by two people again: the reminders go.
    const lifted = await propose(agent, 'lifted', PDF);
    expect(lifted.status).toBe(201);
    await w.staff(manager, 'POST', `/collection/borrower-status/${lifted.body['id'] as string}/approve`);
    expect(await collection.isHeld(l.borrowerPersonId)).toBe(false);
    await repayment.runReminders(at(next?.dueOn ?? '', -3));
    expect(await reminded()).toBe(1);
    expect(await counts()).toEqual(before);
  });
});

describe('closing and assigning', () => {
  it('paid up: the item closed as cured, its open tasks dismissed; back overdue, reopened to the same agent when so set', async () => {
    const l = await loan();
    const due = l.installments[0]?.dueOn ?? '';
    await collection.runCycle(CLI_ACTOR, at(due, 3));
    const first = (await itemOf(l.caseId))?.['id'] as string;
    await pay(l, l.installments[0]?.amountRial ?? 0n);
    await collection.runCycle(CLI_ACTOR, at(due, 4));
    expect(await itemOf(l.caseId)).toMatchObject({ id: first, close_reason: 'cured' });
    expect((await tasksOf(first)).every((t) => t['status'] === 'dismissed')).toBe(true);

    // The next installment overdue: a new item; same agent by the rule turned on.
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('collection.same_agent_for_returning', 'global', 'true', now(), 'approved', 'آزمون', now())`,
    );
    await setShares([{ accountId: otherAgent.id, percent: 100 }]);
    try {
      await collection.runCycle(CLI_ACTOR, at(l.installments[1]?.dueOn ?? '', 3));
      const again = await itemOf(l.caseId);
      expect(again?.['id']).not.toBe(first);
      expect(again?.['assignee_account_id']).toBe(agent.id);
      const { rows } = await h.owner.query<Row>(
        'SELECT kind FROM collection_assignments WHERE item_id = $1',
        [again?.['id']],
      );
      expect(rows).toEqual([{ kind: 'returning' }]);
    } finally {
      await h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('collection.same_agent_for_returning', 'global', 'false', now(), 'approved', 'آزمون', now())`,
      );
      await setShares([{ accountId: agent.id, percent: 100 }]);
    }
  });

  it('by hand only by the strategy manager, with a reason, to an active staff account', async () => {
    const l = await loan();
    await collection.runCycle(CLI_ACTOR, at(l.installments[0]?.dueOn ?? '', 3));
    const itemId = (await itemOf(l.caseId))?.['id'] as string;
    const path = `/collection/items/${itemId}/assign`;
    expect((await w.staff(strategy, 'POST', path, { accountId: otherAgent.id })).status).toBe(400);
    expect(
      (await w.staff(manager, 'POST', path, { accountId: otherAgent.id, reason: 'تقسیم دستی' })).status,
    ).toBe(403);
    const patient = await w.patient();
    expect(
      (await w.staff(strategy, 'POST', path, { accountId: patient.id, reason: 'تقسیم دستی' })).status,
    ).toBe(400);
    const done = await w.staff(strategy, 'POST', path, {
      accountId: otherAgent.id,
      reason: 'آشنایی با وام‌گیرنده',
    });
    expect(done.status).toBe(200);
    expect(
      ((await w.staff(otherAgent, 'GET', '/collection/queue')).body as unknown as Body[]).map(
        (r) => r['itemId'],
      ),
    ).toContain(itemId);
  });
});

// Last: picks through the engine, many transactions.
describe('the collection queue’s distribution (3-5’s engine; deviation under 2%)', () => {
  it('1,000 picks at 50/30/20; a zero share gets nothing', async () => {
    const [a, b, c, zero] = await Promise.all([
      role('collection'),
      role('collection'),
      role('collection'),
      role('collection'),
    ]);
    await setShares([
      { accountId: a.id, percent: 50 },
      { accountId: b.id, percent: 30 },
      { accountId: c.id, percent: 20 },
      { accountId: zero.id, percent: 0 },
    ]);
    const engine = h.app.get<AssignmentEngine>(ASSIGNMENT_ENGINE);
    const db = h.app.get<Database>(DATABASE);
    const key = { queueCode: 'collection', cityCode: 'tehran', treatmentFieldCode: 'dental' };
    const counts = new Map<string, number>();
    for (let i = 0; i < 1_000; i++) {
      const pick = await db.transaction((tx) =>
        engine.pick(tx, key, () => Promise.resolve(new Map())),
      );
      if (pick) counts.set(pick.accountId, (counts.get(pick.accountId) ?? 0) + 1);
    }
    const share = (id: string) => (counts.get(id) ?? 0) / 1_000;
    expect(Math.abs(share(a.id) - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(share(b.id) - 0.3)).toBeLessThan(0.02);
    expect(Math.abs(share(c.id) - 0.2)).toBeLessThan(0.02);
    expect(counts.get(zero.id)).toBeUndefined();
  }, 300_000);
});
