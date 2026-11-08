import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope, TicketLinkType } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { EventDispatcher } from '../../src/infra/outbox/event-dispatcher';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { TicketService } from '../../src/modules/ticket/ticket.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import {
  actorFor,
  createNode,
  grantRole,
  loggedInAccount,
  newIp,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import {
  CREDIT_HARNESS,
  creditWorld,
  PDF,
  type Body,
  type Patient,
  type Row,
} from '../credit/world';

/**
 * Task 7-1 (doc 17 §1, §9 tests 2, 3 and 11; docs/decisions/task-7-1-decisions.md): a ticket
 * links only what its requester may reach, its internal notes never reach the requester, and
 * its deadline stops while it waits on them. Besides: its life, reopening, transfer, the
 * proforma dispute consumer and the copy of task 3-4's support_requests.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let tickets: TicketService;
let accessPort: AccessPort;
let support: LoggedInAccount;
let accounting: LoggedInAccount;
let strategyA: LoggedInAccount;
let strategyB: LoggedInAccount;

const HOUR = 3_600_000;

const role = async (code: string) => {
  const who = await loggedInAccount(h, 'staff');
  await grantRole(h, who.id, code);
  return who;
};

async function setConfig(key: string, value: unknown) {
  const proposal = await w.staff(strategyA, 'POST', '/config/proposals', {
    key,
    scope: { level: 'global' },
    value,
    reason: 'آزمون تیکت',
  });
  expect(proposal.status).toBe(201);
  const approved = await w.staff(
    strategyB,
    'POST',
    `/config/proposals/${proposal.body['id'] as string}/approve`,
  );
  expect(approved.status).toBe(200);
}

const TOPICS = (supportHours: number) => [
  {
    code: 'general',
    title: 'پرسش عمومی',
    unit: 'support',
    responseHours: supportHours,
    active: true,
  },
  {
    code: 'appointment',
    title: 'نوبت',
    unit: 'support',
    responseHours: supportHours,
    active: true,
  },
  {
    code: 'proforma_dispute',
    title: 'اعتراض به پیش‌فاکتور',
    unit: 'support',
    responseHours: 0,
    active: true,
  },
  { code: 'installment', title: 'قسط', unit: 'collection', responseHours: 0, active: true },
  { code: 'payment', title: 'فیش و پرداخت', unit: 'accounting', responseHours: 0, active: true },
];

const open = (p: Patient, body: Body) => w.as(p, 'POST', '/me/tickets', body);
type Link = { type: TicketLinkType; id: string };
const ask = (links: Link[] = [], topicCode = 'appointment') => ({
  topicCode,
  subject: 'پرسش درباره نوبت',
  body: 'سلام، نوبت من چه شد؟',
  links,
});

async function patientOf(p: Patient) {
  return tickets.patient(p.id);
}

async function staffAccess(who: LoggedInAccount) {
  return accessPort.resolve(who.id);
}

async function appointmentOf(p: Patient): Promise<string> {
  const { rows } = await h.owner.query<Row>(
    'SELECT id FROM appointments WHERE patient_account_id = $1 ORDER BY created_at LIMIT 1',
    [p.id],
  );
  return rows[0]?.['id'] as string;
}

/** An issued proforma, not answered: a hold late in the world's day, so no slot is shared. */
async function issuedProforma(p: Patient, minutesBeforeEnd: number): Promise<string> {
  const { rows } = await h.owner.query<Row>(
    `SELECT starts_at FROM appointments WHERE workplace_id = $1 ORDER BY starts_at LIMIT 1`,
    [w.workplaceId],
  );
  // The day runs 08:00 to 20:00 Tehran time; the first slot is at 08:00.
  const first = new Date(rows[0]?.['starts_at'] as string).getTime();
  const startsAt = new Date(first + 12 * HOUR - minutesBeforeEnd * 60_000).toISOString();
  const held = await w.as(p, 'POST', '/booking/appointments/hold', {
    workplaceId: w.workplaceId,
    serviceCode: 'visit',
    startsAt,
  });
  expect(held.status).toBe(201);
  await w.as(p, 'POST', `/booking/appointments/${held.body['id'] as string}/request`);
  await w.examine(p, held.body['id'] as string);
  const made = await w.staff(w.doctor, 'POST', '/proformas', {
    appointmentId: held.body['id'],
    lines: [{ serviceCode: 'visit', quantity: 1, unitRial: '6000000' }],
  });
  expect(made.status).toBe(201);
  const id = made.body['id'] as string;
  expect((await w.staff(w.doctor, 'POST', `/proformas/${id}/issue`)).status).toBe(201);
  return id;
}

async function dispatchDisputeOf(proformaId: string): Promise<void> {
  const { rows } = await h.owner.query<Row>(
    `SELECT id, event_type, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
     WHERE event_type = 'proforma.disputed' AND aggregate_id = $1`,
    [proformaId],
  );
  const row = rows[0];
  expect(row).toBeDefined();
  const envelope: EventEnvelope = {
    id: row?.['id'] as string,
    type: 'proforma.disputed',
    aggregateType: row?.['aggregate_type'] as string,
    aggregateId: row?.['aggregate_id'] as string,
    payload: row?.['payload'],
    occurredAt: new Date(row?.['created_at'] as string).toISOString(),
  };
  await h.app.get(EventDispatcher).dispatch(envelope);
}

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  tickets = h.app.get(TicketService);
  accessPort = h.app.get<AccessPort>(ACCESS_PORT);
  support = await role('support');
  accounting = await role('accounting');
  strategyA = await role('strategy_manager');
  strategyB = await role('strategy_manager');
  for (const [queueCode, who] of [
    ['ticket_support', support],
    ['ticket_accounting', accounting],
  ] as const) {
    const shares = await w.staff(strategyA, 'PUT', '/lead/assignment/shares', {
      queueCode,
      shares: [{ accountId: who.id, percent: 100 }],
      reason: 'سهم صف تیکت',
    });
    expect(shares.status).toBe(200);
  }
  await setConfig('ticket.topics', TOPICS(0));
}, 300_000);

afterAll(async () => {
  await h.close();
});

describe('test 2: a ticket links only what its requester may reach (IDOR)', () => {
  it('a patient: their own appointment and proforma; another’s, or none, alike 404', async () => {
    const { patient: a, proformaId } = await w.confirmedProforma();
    const b = await w.patient();
    const appointmentId = await appointmentOf(a);

    const own = await open(
      a,
      ask([
        { type: 'appointment', id: appointmentId },
        { type: 'proforma', id: proformaId },
      ]),
    );
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ status: 'assigned', unit: 'support', channel: 'patient' });
    expect((own.body['links'] as Body[]).map((l) => l['type'])).toEqual([
      'appointment',
      'proforma',
    ]);
    expect((own.body['links'] as Body[])[0]?.['label']).toMatch(/^نوبت [۰-۹]/);

    for (const link of <Link[]>[
      { type: 'appointment', id: appointmentId },
      { type: 'proforma', id: proformaId },
      { type: 'appointment', id: randomUUID() },
      { type: 'payment', id: randomUUID() },
    ]) {
      const refused = await open(b, ask([link]));
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ error: 'link_not_found', type: link.type });
    }
    // Nothing was written for a refused ticket.
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM tickets t JOIN user_accounts u
         ON u.person_id = t.requester_person_id WHERE u.id = $1`,
      [b.id],
    );
    expect(rows[0]?.['n']).toBe(0);
  });

  it('a center: an appointment of its own workplace; another center’s user gets 404', async () => {
    const { patient } = await w.confirmedProforma();
    const appointmentId = await appointmentOf(patient);

    const mine = await w.staff(
      w.doctor,
      'POST',
      '/panel/tickets',
      ask([{ type: 'appointment', id: appointmentId }]),
    );
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({ channel: 'center' });

    const other = await loggedInAccount(h, 'center');
    const node = await createNode(h, 'center');
    await grantRole(h, other.id, 'center_manager', { kind: 'center', nodeId: node });
    const refused = await w.staff(
      other,
      'POST',
      '/panel/tickets',
      ask([{ type: 'appointment', id: appointmentId }]),
    );
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: 'link_not_found' });
    // Nor does the other center see the first one's ticket.
    expect(
      (await w.staff(other, 'GET', `/panel/tickets/${mine.body['id'] as string}`)).status,
    ).toBe(404);
    // A patient never links a statement, a center never an installment.
    const p = await w.patient();
    expect((await open(p, ask([{ type: 'statement', id: randomUUID() }]))).status).toBe(404);
  });

  it('staff for a caller: checked against the caller’s person; an unknown mobile is 404', async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const made = await w.staff(support, 'POST', '/tickets', {
      ...ask([{ type: 'proforma', id: proformaId }], 'general'),
      mobile: `0${patient.mobile}`,
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ channel: 'staff' });
    // The caller sees it among their own.
    const theirs = await w.as(patient, 'GET', '/me/tickets');
    expect((theirs.body as unknown as Body[]).map((t) => t['id'])).toContain(made.body['id']);

    const stranger = await w.patient();
    const refused = await w.staff(support, 'POST', '/tickets', {
      ...ask([{ type: 'proforma', id: proformaId }], 'general'),
      mobile: stranger.mobile,
    });
    expect(refused.status).toBe(404);
    expect(
      (
        await w.staff(support, 'POST', '/tickets', {
          ...ask([], 'general'),
          mobile: '9120000000',
        })
      ).body,
    ).toMatchObject({ error: 'person_not_found' });
  });

  it('a borrower: their installment and slip; another patient and a center get 404', async () => {
    const steps = fundingSteps(h, w, {
      manager: await w.role('credit_manager'),
      finance: await w.role('accounting'),
    });
    const { patient, applicationId } = await steps.approved();
    await steps.complete(patient, applicationId);
    const purseId = await steps.fund(applicationId);
    const purse = await h.app.get(WalletService).summary(purseId);
    const repayment = h.app.get(RepaymentService);
    const [scheduleId] = await repayment.schedulesOf(purse.caseId);
    const schedule = await repayment.schedule(scheduleId ?? '');
    const installmentId = schedule.installments[0]?.id ?? '';
    const { paymentId } = await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `test:ticket:${scheduleId ?? ''}`,
      scheduleId: scheduleId ?? '',
      amountRial: 1_000_000n,
      receivedAt: new Date(),
      reference: 'TRK-TICKET-1',
      paidOn: '2026-10-01',
      channel: 'manual_receipt',
    });
    const links: Link[] = [
      { type: 'installment', id: installmentId },
      { type: 'payment', id: paymentId },
    ];
    const own = await open(patient, ask(links, 'payment'));
    expect(own.status).toBe(201);
    expect((own.body['links'] as Body[]).map((l) => l['label'])).toEqual(['قسط ۱', 'فیش واریزی']);

    const other = await w.patient();
    for (const link of links) {
      expect((await open(other, ask([link], 'payment'))).status).toBe(404);
      expect((await w.staff(w.doctor, 'POST', '/panel/tickets', ask([link]))).status).toBe(404);
    }
  });
});

describe('test 3: an internal note never reaches the requester', () => {
  it('neither its text nor its file, by the view, the list or a link; staff see both', async () => {
    const p = await w.patient();
    const made = await open(p, ask([], 'general'));
    const id = made.body['id'] as string;

    expect(
      (
        await w.staff(support, 'POST', `/tickets/${id}/messages`, {
          body: 'یادداشت داخلی: بیمار بدقول است',
          visibility: 'internal',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await w.staff(support, 'POST', `/tickets/${id}/messages`, {
          body: 'پاسخ: پیگیری می‌کنیم.',
          visibility: 'public',
        })
      ).status,
    ).toBe(200);
    const form = new FormData();
    form.set('visibility', 'internal');
    form.set('file', new Blob([PDF], { type: 'application/pdf' }), 'note.pdf');
    const upload = await fetch(`${h.baseUrl}/tickets/${id}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${support.access}`, 'x-forwarded-for': newIp() },
      body: form,
    });
    expect(upload.status).toBe(201);
    const internalFile = ((await upload.json()) as Body)['id'] as string;

    const seen = await w.as(p, 'GET', `/me/tickets/${id}`);
    expect(seen.status).toBe(200);
    const text = JSON.stringify(seen.body);
    expect(text).not.toContain('یادداشت داخلی');
    expect(text).not.toContain('internal');
    expect(text).not.toContain(internalFile);
    expect((seen.body['messages'] as Body[]).map((m) => m['body'])).toEqual([
      'سلام، نوبت من چه شد؟',
      'پاسخ: پیگیری می‌کنیم.',
    ]);
    expect(seen.body['attachments']).toEqual([]);
    expect(
      (await w.as(p, 'GET', `/me/tickets/${id}/attachments/${internalFile}/link`)).status,
    ).toBe(404);

    // A requester cannot write an internal note, nor add an internal file.
    const theirs = new FormData();
    theirs.set('visibility', 'internal');
    theirs.set('file', new Blob([PDF], { type: 'application/pdf' }), 'mine.pdf');
    const refused = await fetch(`${h.baseUrl}/me/tickets/${id}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.token}`, 'x-forwarded-for': newIp() },
      body: theirs,
    });
    expect(refused.status).toBe(403);
    expect(
      (
        await w.as(p, 'POST', `/me/tickets/${id}/messages`, {
          body: 'x',
          visibility: 'internal',
        })
      ).status,
    ).toBe(400);

    const staff = await w.staff(support, 'GET', `/tickets/${id}`);
    expect((staff.body['messages'] as Body[]).map((m) => m['visibility'])).toEqual([
      'public',
      'internal',
      'public',
    ]);
    expect((staff.body['attachments'] as Body[]).map((a) => a['id'])).toEqual([internalFile]);
    expect(
      (await w.staff(support, 'GET', `/tickets/${id}/attachments/${internalFile}/link`)).status,
    ).toBe(200);
  });

  it('the same for a center’s ticket', async () => {
    const made = await w.staff(w.doctor, 'POST', '/panel/tickets', ask([], 'general'));
    const id = made.body['id'] as string;
    await w.staff(support, 'POST', `/tickets/${id}/messages`, {
      body: 'یادداشت داخلی درباره مرکز',
      visibility: 'internal',
    });
    const seen = await w.staff(w.doctor, 'GET', `/panel/tickets/${id}`);
    expect(JSON.stringify(seen.body)).not.toContain('یادداشت داخلی');
    expect(seen.body['messages'] as Body[]).toHaveLength(1);
  });
});

describe('test 11: the deadline stops while waiting on the requester', () => {
  it('no alert while waiting; moved by the wait; then breached once', async () => {
    await setConfig('ticket.topics', TOPICS(2));
    const p = await w.patient();
    const party = await patientOf(p);
    const actor = actorFor(p.id);
    const staff = actorFor(support.id);
    const access = await staffAccess(support);
    const t0 = new Date(Date.now() + 60_000);
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    const opened = await tickets.openForPatient(actor, party, ask([], 'general'), t0);
    expect(opened.dueAt).toBe(new Date(t0.getTime() + 2 * HOUR).toISOString());
    const id = opened.id;

    await tickets.changeStatus(staff, access, id, { to: 'in_progress' }, at(10));
    const waiting = await tickets.changeStatus(
      staff,
      access,
      id,
      { to: 'waiting_on_requester', note: 'لطفاً شماره نوبت را بفرستید.' },
      at(30),
    );
    expect(waiting.paused).toBe(true);

    const events = async (kind: string) =>
      (
        await h.owner.query<Row>(
          'SELECT due_at FROM ticket_events WHERE ticket_id = $1 AND kind = $2',
          [id, kind],
        )
      ).rows;

    // Three hours on: the first deadline passed, but the ticket waits on the requester.
    await tickets.sweep(CLI_ACTOR, at(180));
    expect(await events('sla_breached')).toHaveLength(0);
    const staffView = await w.staff(support, 'GET', '/tickets/queue');
    expect((staffView.body as unknown as Body[]).find((r) => r['id'] === id)?.['overdue']).toBe(
      false,
    );

    // The requester answers at five hours: the deadline moves by the 4.5 hours waited.
    const answered = await tickets.replyAsRequester(actor, party, id, 'شماره: ۱۲۳', at(300));
    expect(answered.status).toBe('in_progress');
    expect(answered.paused).toBe(false);
    const moved = new Date(t0.getTime() + 2 * HOUR + 270 * 60_000);
    expect(answered.dueAt).toBe(moved.toISOString());

    await tickets.sweep(CLI_ACTOR, at(380));
    expect(await events('sla_breached')).toHaveLength(0);
    await tickets.sweep(CLI_ACTOR, at(400));
    await tickets.sweep(CLI_ACTOR, at(420));
    const breached = await events('sla_breached');
    expect(breached).toHaveLength(1);
    expect(new Date(breached[0]?.['due_at'] as string).toISOString()).toBe(moved.toISOString());
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM outbox_events
       WHERE event_type = 'ticket.sla_breached' AND aggregate_id = $1`,
      [id],
    );
    expect(rows[0]?.['n']).toBe(1);
    await setConfig('ticket.topics', TOPICS(0));
  });
});

describe('the ticket’s life', () => {
  it('only along its path, in the service and in the database', async () => {
    const p = await w.patient();
    const made = await open(p, ask([], 'general'));
    const id = made.body['id'] as string;
    expect(made.body['status']).toBe('assigned');
    const wrong = await w.staff(support, 'POST', `/tickets/${id}/status`, {
      to: 'waiting_on_requester',
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ error: 'invalid_transition', status: 'assigned' });
    await expect(
      h.owner.query(
        `UPDATE tickets SET status = 'closed', closed_at = now(),
        resolved_at = now() WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/cannot go from assigned to closed/);
    await expect(h.owner.query('DELETE FROM tickets WHERE id = $1', [id])).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      h.owner.query(`UPDATE tickets SET subject = 'دیگر' WHERE id = $1`, [id]),
    ).rejects.toThrow(/keeps what was asked/);
    // Read-only roles and other units only read, never write.
    const ceo = await role('ceo');
    expect((await w.staff(ceo, 'GET', `/tickets/${id}`)).status).toBe(200);
    expect(
      (await w.staff(ceo, 'POST', `/tickets/${id}/messages`, { body: 'x', visibility: 'public' }))
        .status,
    ).toBe(403);
    expect((await w.staff(accounting, 'GET', `/tickets/${id}`)).status).toBe(404);
  });

  it('reopened only within ticket.reopen_days; closed by the sweep after it', async () => {
    const p = await w.patient();
    const party = await patientOf(p);
    const actor = actorFor(p.id);
    const made = await open(p, ask([], 'general'));
    const id = made.body['id'] as string;
    await w.staff(support, 'POST', `/tickets/${id}/status`, { to: 'resolved', note: 'انجام شد.' });

    // 0 days (the initial value): never.
    const off = await w.as(p, 'POST', `/me/tickets/${id}/reopen`, { reason: 'هنوز درست نشده' });
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ error: 'reopen_window_closed' });

    await setConfig('ticket.reopen_days', 3);
    expect((await w.as(p, 'GET', `/me/tickets/${id}`)).body['canReopen']).toBe(true);
    const again = await w.as(p, 'POST', `/me/tickets/${id}/reopen`, { reason: 'هنوز درست نشده' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'reopened', resolvedAt: null });
    await w.staff(support, 'POST', `/tickets/${id}/status`, { to: 'resolved' });
    await expect(
      tickets.reopen(actor, party, id, 'دیرتر', new Date(Date.now() + 4 * 24 * HOUR)),
    ).rejects.toMatchObject({ response: { error: 'reopen_window_closed' } });

    await tickets.sweep(CLI_ACTOR, new Date(Date.now() + 2 * 24 * HOUR));
    expect((await w.as(p, 'GET', `/me/tickets/${id}`)).body['status']).toBe('resolved');
    await tickets.sweep(CLI_ACTOR, new Date(Date.now() + 4 * 24 * HOUR));
    const closed = await w.as(p, 'GET', `/me/tickets/${id}`);
    expect(closed.body).toMatchObject({ status: 'closed', canReopen: false });
    await setConfig('ticket.reopen_days', 0);
  });

  it('transferred with a reason: unassigned there, then the engine’s; the history kept', async () => {
    const p = await w.patient();
    const made = await open(p, ask([], 'general'));
    const id = made.body['id'] as string;
    expect(
      (
        await w.staff(support, 'POST', `/tickets/${id}/transfer`, {
          unit: 'nowhere',
          reason: 'آزمون',
        })
      ).status,
    ).toBe(400);
    const moved = await w.staff(support, 'POST', `/tickets/${id}/transfer`, {
      unit: 'accounting',
      reason: 'موضوع مالی است',
    });
    expect(moved.status).toBe(200);
    const there = await w.staff(accounting, 'GET', `/tickets/${id}`);
    expect(there.body).toMatchObject({
      unit: 'accounting',
      status: 'assigned',
      assigneeAccountId: accounting.id,
    });
    expect((there.body['events'] as Body[]).map((e) => e['kind'])).toEqual([
      'opened',
      'assigned',
      'transferred',
      'assigned',
    ]);
    expect((there.body['events'] as Body[])[2]).toMatchObject({
      fromUnit: 'support',
      toUnit: 'accounting',
      reason: 'موضوع مالی است',
    });
    // Support no longer sees it.
    expect((await w.staff(support, 'GET', `/tickets/${id}`)).status).toBe(404);
    // By hand only to someone of the unit.
    const manager = await role('strategy_manager');
    const wrong = await w.staff(manager, 'POST', `/tickets/${id}/assign`, {
      accountId: support.id,
      reason: 'دستی',
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ error: 'assignee_not_in_unit' });
  });
});

describe('task 3-4’s proforma disputes, as tickets', () => {
  it('the consumer opens one per proforma, with the note and the link', async () => {
    const p = await w.patient();
    // A first proforma, confirmed, gives this patient an appointment of their own.
    await w.confirmedProforma(p);
    const proformaId = await issuedProforma(p, 30);
    const disputed = await w.as(p, 'POST', `/me/proformas/${proformaId}/dispute`, {
      note: 'مبلغ جرم‌گیری بیش از تعرفه است',
    });
    expect(disputed.status).toBe(201);
    await dispatchDisputeOf(proformaId);
    await dispatchDisputeOf(proformaId);
    const { rows } = await h.owner.query<Row>(
      `SELECT id, status, unit, requester_person_id FROM tickets
       WHERE source = 'proforma_dispute' AND source_id = $1`,
      [proformaId],
    );
    expect(rows).toHaveLength(1);
    const seen = await w.as(p, 'GET', `/me/tickets/${rows[0]?.['id'] as string}`);
    expect(seen.body).toMatchObject({ topicCode: 'proforma_dispute', unit: 'support' });
    expect((seen.body['messages'] as Body[])[0]?.['body']).toBe('مبلغ جرم‌گیری بیش از تعرفه است');
    expect(seen.body['links']).toEqual([
      { type: 'proforma', id: proformaId, label: 'پیش‌فاکتور، نسخه ۱' },
    ]);
    // The proforma module's own record is untouched.
    const kept = await h.owner.query<Row>(
      'SELECT note, status FROM support_requests WHERE subject_id = $1',
      [proformaId],
    );
    expect(kept.rows).toEqual([{ note: 'مبلغ جرم‌گیری بیش از تعرفه است', status: 'open' }]);
  });

  it('migration 0063 copies an existing support_request once, and the event adds nothing', async () => {
    const p = await w.patient();
    await w.confirmedProforma(p);
    const proformaId = await issuedProforma(p, 60);
    await w.as(p, 'POST', `/me/proformas/${proformaId}/dispute`, { note: 'اعتراض پیش از ۷-۱' });
    const sql = readFileSync(
      path.join(__dirname, '..', '..', 'drizzle', '0063_tickets.sql'),
      'utf8',
    );
    const copy = sql.slice(sql.indexOf("-- === Task 3-4's proforma disputes"));
    for (let run = 0; run < 2; run += 1) {
      for (const statement of copy.split('--> statement-breakpoint')) {
        if (statement.trim()) await h.owner.query(statement);
      }
    }
    await dispatchDisputeOf(proformaId);
    const { rows } = await h.owner.query<Row>(
      `SELECT t.id, t.legacy_support_request_id IS NOT NULL AS legacy,
         (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages,
         (SELECT count(*)::int FROM ticket_links l WHERE l.ticket_id = t.id) AS links,
         (SELECT count(*)::int FROM ticket_events e WHERE e.ticket_id = t.id) AS events
       FROM tickets t WHERE t.source = 'proforma_dispute' AND t.source_id = $1`,
      [proformaId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ legacy: true, messages: 1, links: 1, events: 1 });
    const seen = await w.as(p, 'GET', `/me/tickets/${rows[0]?.['id'] as string}`);
    expect((seen.body['messages'] as Body[])[0]?.['body']).toBe('اعتراض پیش از 7-1'); // digits normalized before storage (rule 23)
    // Opened before any queue took it: the sweep assigns it.
    await tickets.sweep(CLI_ACTOR);
    expect((await w.as(p, 'GET', `/me/tickets/${rows[0]?.['id'] as string}`)).body['status']).toBe(
      'assigned',
    );
  });
});

describe('a unit’s agents to assign to (task 7-7)', () => {
  it('its active staff who work tickets, by name and unit only, for ticket.assign', async () => {
    const listed = await w.staff(strategyA, 'GET', '/tickets/units/support/agents');
    expect(listed.status).toBe(200);
    const agents = listed.body as unknown as Body[];
    const theirs = agents.find((a) => a['accountId'] === support.id);
    expect(theirs).toBeDefined();
    expect(Object.keys(theirs ?? {}).sort()).toEqual(['accountId', 'name', 'unit']);
    expect(theirs?.['unit']).toBe('support');
    // Not another unit's agent, and nobody without ticket.assign may ask.
    expect(agents.some((a) => a['accountId'] === accounting.id)).toBe(false);
    expect((await w.staff(support, 'GET', '/tickets/units/support/agents')).status).toBe(403);
  });
});
