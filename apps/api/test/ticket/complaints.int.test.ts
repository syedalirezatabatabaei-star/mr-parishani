import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { EventEnvelope } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { EventDispatcher } from '../../src/infra/outbox/event-dispatcher';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import {
  CapturingTextSender,
  createNode,
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
 * Task 7-2 [financial] (doc 17 §1, §9 tests 1 and 4; owner ج۱–ج۴): a financial complaint holds
 * its item through 5-2's dispute in the same transaction and ends only with that dispute's
 * decision; a patient's complaint about a doctor reaches that doctor's panel and gets their
 * answer; the collection unit never sees a treatment record through a ticket; 5-2's disputes
 * from before tickets are copied once into complaints, left as they are.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let steps: ReturnType<typeof fundingSteps>;
let finance: LoggedInAccount;
let finance2: LoggedInAccount;
let support: LoggedInAccount;
let agent: LoggedInAccount;
const texts = new CapturingTextSender();

const settlement = () => h.app.get(SettlementService);
const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  w = await creditWorld(h);
  finance = await w.role('accounting');
  finance2 = await w.role('accounting');
  support = await w.role('support');
  agent = await w.role('collection');
  steps = fundingSteps(h, w, { manager: await w.role('credit_manager'), finance });
  const strategy = await w.role('strategy_manager');
  for (const [queueCode, who] of [
    ['ticket_accounting', finance],
    ['ticket_support', support],
    ['ticket_collection', agent],
  ] as const) {
    const shares = await w.staff(strategy, 'PUT', '/lead/assignment/shares', {
      queueCode,
      shares: [{ accountId: who.id, percent: 100 }],
      reason: 'سهم صف تیکت',
    });
    expect(shares.status).toBe(200);
  }
}, 240_000);

afterAll(async () => {
  await h.close();
});

/** A funded purse, one service final, its payable (due) and fee: as 5-2's tests make it. */
async function payable() {
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
  const { payableId } = await settlement().accrue(CLI_ACTOR, made.body['id'] as string);
  const { rows } = await h.owner.query<Row>(
    'SELECT due_at, doctor_node_id FROM doctor_payables WHERE id = $1',
    [payableId],
  );
  await settlement().markDue(rows[0]?.['due_at'] as Date);
  return { payableId, doctorNodeId: rows[0]?.['doctor_node_id'] as string, patient };
}

async function statusOf(payableId: string) {
  const { rows } = await h.owner.query<Row>(
    'SELECT status, statement_id FROM doctor_payables WHERE id = $1',
    [payableId],
  );
  return rows[0];
}

async function dispatch(type: string, aggregateId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT id, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
     WHERE event_type = $1 AND aggregate_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [type, aggregateId],
  );
  const row = rows[0];
  expect(row).toBeDefined();
  const envelope: EventEnvelope = {
    id: row?.['id'] as string,
    type,
    aggregateType: row?.['aggregate_type'] as string,
    aggregateId: row?.['aggregate_id'] as string,
    payload: row?.['payload'],
    occurredAt: new Date(row?.['created_at'] as string).toISOString(),
  };
  await h.app.get(EventDispatcher).dispatch(envelope);
}

const financial = (payableId: string) => ({
  topicCode: 'complaint_financial',
  subject: 'اعتراض به بدهی خدمت',
  body: 'مبلغ این خدمت را قبول ندارم.',
  links: [{ type: 'doctor_payable', id: payableId }],
});

describe('test 1: a financial complaint holds its item until its dispute is decided', () => {
  it('on_hold and out of every payment; rejected, back for the next statement; resolved', async () => {
    const item = await payable();
    expect((await settlement().payableItems(item.doctorNodeId)).payables).toContain(item.payableId);

    const made = await w.staff(w.doctor, 'POST', '/panel/tickets', financial(item.payableId));
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ kind: 'complaint', unit: 'accounting', status: 'assigned' });
    const id = made.body['id'] as string;
    expect(await statusOf(item.payableId)).toMatchObject({ status: 'on_hold' });
    expect((await settlement().payableItems(item.doctorNodeId)).payables).not.toContain(
      item.payableId,
    );
    const { rows } = await h.owner.query<Row>(
      'SELECT id, ticket_id, status FROM financial_disputes WHERE subject_id = $1',
      [item.payableId],
    );
    expect(rows).toEqual([{ id: expect.any(String) as unknown, ticket_id: id, status: 'open' }]);
    const disputeId = rows[0]?.['id'] as string;
    const opened = await h.owner.query<Row>(
      `SELECT payload FROM outbox_events WHERE event_type = 'complaint.financial_opened'
       AND aggregate_id = $1`,
      [id],
    );
    expect(opened.rows[0]?.['payload']).toMatchObject({ ticketId: id, disputeId });

    // Closed only by deciding the dispute.
    const early = await w.staff(finance, 'POST', `/tickets/${id}/status`, { to: 'resolved' });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: 'dispute_pending' });
    expect((await w.staff(finance, 'GET', `/tickets/${id}`)).body).toMatchObject({
      financialDisputeId: disputeId,
      disputeStatus: 'open',
    });

    // Accounting decides it by 5-2's own endpoint: rejected.
    const decided = await w.staff(finance2, 'POST', `/settlement/disputes/${disputeId}/resolve`, {
      outcome: 'rejected',
      note: 'بررسی شد',
    });
    expect(decided.status).toBe(201);
    expect(await statusOf(item.payableId)).toMatchObject({ status: 'due', statement_id: null });
    expect((await settlement().payableItems(item.doctorNodeId)).payables).toContain(item.payableId);

    await dispatch('settlement.dispute_resolved', disputeId);
    await dispatch('settlement.dispute_resolved', disputeId);
    const seen = await w.staff(w.doctor, 'GET', `/panel/tickets/${id}`);
    expect(seen.body).toMatchObject({ status: 'resolved', canReopen: false });
    expect((seen.body['messages'] as Body[]).map((m) => m['body'])).toEqual([
      'مبلغ این خدمت را قبول ندارم.',
      'اختلاف مالی رد شد؛ قلم در صورت‌وضعیت بعدی می‌آید.',
    ]);
    const again = await w.staff(w.doctor, 'POST', `/panel/tickets/${id}/reopen`, {
      reason: 'باز هم قبول ندارم',
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'complaint_not_reopenable' });
  });

  it('a hold refused is no complaint at all; the item and the link only the doctor’s', async () => {
    const item = await payable();
    // Already held by a dispute of support's: the complaint is refused whole.
    const direct = await w.staff(support, 'POST', '/settlement/disputes', {
      subjectType: 'doctor_payable',
      subjectId: item.payableId,
      reason: 'پشتیبانی پیش از این باز کرد',
    });
    expect(direct.status).toBe(201);
    const refused = await w.staff(w.doctor, 'POST', '/panel/tickets', financial(item.payableId));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'dispute_open' });
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM ticket_links WHERE entity_id = $1`,
      [item.payableId],
    );
    expect(rows[0]?.['n']).toBe(0);

    // Another center’s user, and a patient, never reach the doctor's payable.
    const other = await loggedInAccount(h, 'center');
    await grantRole(h, other.id, 'center_manager', {
      kind: 'center',
      nodeId: await createNode(h, 'center'),
    });
    expect((await w.staff(other, 'POST', '/panel/tickets', financial(item.payableId))).status).toBe(
      404,
    );
    expect(
      (await w.as(item.patient, 'POST', '/me/tickets', financial(item.payableId))).status,
    ).toBe(404);
    // A financial topic without its item.
    const bare = await w.staff(w.doctor, 'POST', '/panel/tickets', {
      ...financial(item.payableId),
      links: [],
    });
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ error: 'financial_link_required' });
  });
});

describe('a patient’s complaint about a doctor', () => {
  it('in the doctor’s panel, without the patient’s contact; the answer back to the patient', async () => {
    const { patient } = await w.confirmedProforma();
    const { rows } = await h.owner.query<Row>(
      'SELECT id FROM appointments WHERE patient_account_id = $1 LIMIT 1',
      [patient.id],
    );
    const made = await w.as(patient, 'POST', '/me/tickets', {
      topicCode: 'complaint_doctor',
      subject: 'رفتار پزشک',
      body: 'برخورد خوبی نداشتند.',
      links: [{ type: 'appointment', id: rows[0]?.['id'] }],
    });
    expect(made.status).toBe(201);
    const id = made.body['id'] as string;

    const list = await w.staff(w.doctor, 'GET', '/panel/complaints');
    expect((list.body as unknown as Body[]).map((t) => t['id'])).toContain(id);
    const seen = await w.staff(w.doctor, 'GET', `/panel/complaints/${id}`);
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).not.toContain(patient.mobile);
    const answered = await w.staff(w.doctor, 'POST', `/panel/complaints/${id}/respond`, {
      body: 'عذرخواهی می‌کنم.',
    });
    expect(answered.status).toBe(200);
    const theirs = await w.as(patient, 'GET', `/me/tickets/${id}`);
    expect((theirs.body['messages'] as Body[]).map((m) => [m['side'], m['body']])).toEqual([
      ['requester', 'برخورد خوبی نداشتند.'],
      ['respondent', 'عذرخواهی می‌کنم.'],
    ]);

    const other = await loggedInAccount(h, 'center');
    const node = await createNode(h, 'doctor', { accountId: other.id });
    await grantRole(h, other.id, 'doctor', { kind: 'doctor', nodeId: node });
    expect((await w.staff(other, 'GET', `/panel/complaints/${id}`)).status).toBe(404);
    expect((await w.staff(other, 'GET', '/panel/complaints')).body).not.toContainEqual(
      expect.objectContaining({ id }),
    );
  });
});

describe('test 4: the collection unit sees no treatment through a ticket', () => {
  it('no treatment link, marked message or file; nor the center; by any endpoint', async () => {
    const { patient } = await w.confirmedProforma();
    const { rows } = await h.owner.query<Row>(
      'SELECT id FROM appointments WHERE patient_account_id = $1 LIMIT 1',
      [patient.id],
    );
    const made = await w.as(patient, 'POST', '/me/tickets', {
      topicCode: 'installment',
      subject: 'قسط این ماه',
      body: 'قسط را دیر می‌دهم.',
      links: [{ type: 'appointment', id: rows[0]?.['id'] }],
    });
    expect(made.status).toBe(201);
    const id = made.body['id'] as string;
    await w.as(patient, 'POST', `/me/tickets/${id}/messages`, {
      body: 'جرم‌گیری دندانم هنوز درد دارد',
      containsTreatment: true,
    });
    const told = await w.as(patient, 'POST', `/me/tickets/${id}/messages`, {
      body: 'دکتر اعتبار گفت دوباره بیایم',
    });
    const toldId = (told.body['messages'] as Body[]).at(-1)?.['id'] as string;
    const form = new FormData();
    form.set('containsTreatment', 'true');
    form.set('file', new Blob([PDF], { type: 'application/pdf' }), 'xray.pdf');
    const upload = await fetch(`${h.baseUrl}/me/tickets/${id}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${patient.token}`, 'x-forwarded-for': newIp() },
      body: form,
    });
    expect(upload.status).toBe(201);
    const fileId = ((await upload.json()) as Body)['id'] as string;
    // A manager marks the second message after it was written.
    const manager = await w.role('collection_manager');
    await grantRole(h, manager.id, 'strategy_manager');
    expect(
      (
        await w.staff(manager, 'POST', `/tickets/${id}/messages/${toldId}/flag`, {
          reason: 'نام پزشک دارد',
        })
      ).status,
    ).toBe(200);

    const seen = await w.staff(agent, 'GET', `/tickets/${id}`);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ unit: 'collection', links: [], attachments: [] });
    expect((seen.body['messages'] as Body[]).map((m) => m['body'])).toEqual(['قسط را دیر می‌دهم.']);
    const text = JSON.stringify(seen.body);
    for (const word of ['جرم‌گیری', 'دکتر', 'نوبت', 'کلینیک', fileId]) {
      expect(text).not.toContain(word);
    }
    const queue = JSON.stringify((await w.staff(agent, 'GET', '/tickets/queue')).body);
    for (const word of ['جرم‌گیری', 'دکتر', 'نوبت', 'کلینیک']) expect(queue).not.toContain(word);
    expect((await w.staff(agent, 'GET', `/tickets/${id}/attachments/${fileId}/link`)).status).toBe(
      404,
    );
    // A manager sees it all, marked as such.
    const full = await w.staff(manager, 'GET', `/tickets/${id}`);
    expect(full.body['links'] as Body[]).toHaveLength(1);
    expect((full.body['messages'] as Body[]).map((m) => m['containsTreatment'])).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe('5-2’s disputes from before tickets (migration 0064, ج۲)', () => {
  it('each copied once into a complaint; the dispute itself untouched', async () => {
    const item = await payable();
    const direct = await w.staff(support, 'POST', '/settlement/disputes', {
      subjectType: 'doctor_payable',
      subjectId: item.payableId,
      reason: 'اختلاف پیش از ۷-۲',
    });
    const disputeId = direct.body['id'] as string;
    const before = (
      await h.owner.query<Row>('SELECT * FROM financial_disputes WHERE id = $1', [disputeId])
    ).rows[0];
    const sql = readFileSync(
      path.join(__dirname, '..', '..', 'drizzle', '0064_complaints.sql'),
      'utf8',
    );
    const copy = sql.slice(sql.indexOf("-- === Task 5-2's disputes"));
    for (let run = 0; run < 2; run += 1) {
      for (const statement of copy.split('--> statement-breakpoint')) {
        if (statement.trim()) await h.owner.query(statement);
      }
    }
    const { rows } = await h.owner.query<Row>(
      `SELECT t.id, t.kind, t.requester_channel, t.status, t.unit,
         (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages,
         (SELECT count(*)::int FROM ticket_links l WHERE l.ticket_id = t.id) AS links
       FROM tickets t WHERE t.financial_dispute_id = $1`,
      [disputeId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'complaint',
      requester_channel: 'internal',
      status: 'open',
      unit: 'accounting',
      messages: 1,
      links: 1,
    });
    const after = (
      await h.owner.query<Row>('SELECT * FROM financial_disputes WHERE id = $1', [disputeId])
    ).rows[0];
    expect(after).toEqual(before);
    const seen = await w.staff(finance, 'GET', `/tickets/${rows[0]?.['id'] as string}`);
    expect(seen.body).toMatchObject({ financialDisputeId: disputeId, disputeStatus: 'open' });
  });
});

describe('the topics an opener picks (task 7-7)', () => {
  it('a patient never sees a financial complaint; a center does; neither sees unit or deadline', async () => {
    const { patient } = await w.confirmedProforma();
    const mine = await w.as(patient, 'GET', '/me/tickets/topics');
    expect(mine.status).toBe(200);
    const patientTopics = mine.body as unknown as Body[];
    expect(patientTopics.map((t) => t['code'])).toContain('complaint_doctor');
    expect(patientTopics.some((t) => t['financial'] === true)).toBe(false);
    const center = await w.staff(w.doctor, 'GET', '/panel/tickets/topics');
    expect(center.status).toBe(200);
    const centerTopics = center.body as unknown as Body[];
    expect(centerTopics.find((t) => t['code'] === 'complaint_financial')).toMatchObject({
      kind: 'complaint',
      financial: true,
    });
    const staff = await w.staff(await w.role('support'), 'GET', '/tickets/topics');
    expect(staff.status).toBe(200);
    expect((staff.body as unknown as Body[]).some((t) => t['financial'] === true)).toBe(false);
    for (const t of [...patientTopics, ...centerTopics]) {
      expect(Object.keys(t).sort()).toEqual(['code', 'financial', 'kind', 'title']);
    }
  });
});

describe('the panel’s «اعتراض» is a financial complaint (task 7-7, the owner’s ruling)', () => {
  it('an item held by an open complaint takes no second one; 5-2’s rows are left as they were', async () => {
    const item = await payable();
    const before = await h.owner.query<Row>('SELECT * FROM financial_disputes ORDER BY id');
    const first = await w.staff(w.doctor, 'POST', '/panel/tickets', {
      ...financial(item.payableId),
      subject: 'اعتراض به قلم تسویه',
    });
    expect(first.status).toBe(201);
    expect(await statusOf(item.payableId)).toMatchObject({ status: 'on_hold' });

    // The same objection again, while the first holds the item: refused, nothing made.
    const tickets = async () =>
      (
        await h.owner.query<Row>(
          `SELECT count(*)::int AS n FROM ticket_links WHERE entity_id = $1`,
          [item.payableId],
        )
      ).rows[0]?.['n'];
    const second = await w.staff(w.doctor, 'POST', '/panel/tickets', {
      ...financial(item.payableId),
      subject: 'اعتراض به قلم تسویه',
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'dispute_open' });
    expect(await tickets()).toBe(1);

    // Every row that was there before, from 5-2 and from earlier tests, is unchanged; the only
    // new one is the first complaint's.
    const after = await h.owner.query<Row>('SELECT * FROM financial_disputes ORDER BY id');
    const old = new Set(before.rows.map((r) => r['id'] as string));
    expect(after.rows.filter((r) => old.has(r['id'] as string))).toEqual(before.rows);
    const added = after.rows.filter((r) => !old.has(r['id'] as string));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      subject_id: item.payableId,
      status: 'open',
      ticket_id: first.body['id'],
    });
  });
});
