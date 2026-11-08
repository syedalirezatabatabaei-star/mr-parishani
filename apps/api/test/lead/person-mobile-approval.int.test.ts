import { sql } from 'drizzle-orm';
import { PERSON_DIRECTORY, type EventEnvelope, type PersonDirectory } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_LOG, type AuditLog } from '../../src/common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import { LEAD_CASES, type LeadCases } from '../../src/common/lead/lead-cases.port';
import {
  NOTIFICATIONS,
  type NotificationsPort,
} from '../../src/common/notification/notifications.port';
import { writeSheet } from '../../src/common/xlsx';
import { DATABASE, type Database } from '../../src/db/database.module';
import {
  FactorNoticeConsumer,
  FactorNotices,
  PersonMobileNoticeConsumer,
} from '../../src/modules/identity/factor-notices';
import { LeadImportProcessor } from '../../src/modules/lead/import-processor';
import { LeadIntakeService } from '../../src/modules/lead/intake.service';
import { PersonMobileApprovalService } from '../../src/modules/lead/person-mobile-approval.service';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { nationalId } from '../catalog/fixtures';
import { fundingSteps } from '../credit/funding-steps';
import {
  CREDIT_HARNESS,
  creditWorld,
  PLAN,
  type Body,
  type Patient,
  type Row,
} from '../credit/world';
import {
  actorFor,
  grantRole,
  loggedInAccount,
  newIp,
  newMobile,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * Task 9-3, go-live blocker م۵ (owner 1405/07/19): a national ID is no secret, so a mobile
 * added to a Person who already existed (an advisor's intake, the Excel import, a credit
 * transfer's recipient) is pending. It gives nothing of that Person and gets no SMS, through
 * every path that reads person_mobiles, until the holder of a proved mobile of the same
 * Person approves it in their own panel (الف) or permitted staff with evidence (ب); refused
 * by itself at the deadline (30 days by default). The proved mobiles are told at once (R2).
 * A merge needs R1 and is told the same way.
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let db: Database;
let advisor: LoggedInAccount;
let approverA: LoggedInAccount;
let approverB: LoggedInAccount;
let approverC: LoggedInAccount;
let plain: LoggedInAccount;
let manager: LoggedInAccount;
let steps: ReturnType<typeof fundingSteps>;

const reason = { reason: 'آزمون موبایل افزوده' };

async function setConfig(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2::jsonb, $3, 'approved', 'آزمون', $3)`,
    [key, JSON.stringify(value), new Date()],
  );
}

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  db = h.app.get<Database>(DATABASE);
  advisor = await w.role('advisor');
  manager = await w.role('strategy_manager');
  const finance = await w.role('accounting');
  steps = fundingSteps(h, w, { manager: await w.role('credit_manager'), finance });
  // No role has the permission (migration 0081): a test role gives it.
  await h.owner.query(
    `INSERT INTO roles (code, name, is_system) VALUES ('test_mobile_approver', 'آزمون', false)`,
  );
  await h.owner.query(
    `INSERT INTO role_permissions (role_id, permission_code)
     SELECT id, p FROM roles, unnest(ARRAY['lead.approve_person_mobile', 'lead.intake_manual']) p
      WHERE code = 'test_mobile_approver'`,
  );
  approverA = await loggedInAccount(h, 'staff');
  approverB = await loggedInAccount(h, 'staff');
  approverC = await loggedInAccount(h, 'staff');
  plain = await loggedInAccount(h, 'staff');
  await grantRole(h, approverA.id, 'test_mobile_approver');
  await grantRole(h, approverB.id, 'test_mobile_approver');
  await grantRole(h, approverC.id, 'test_mobile_approver');
  await setConfig('identity.factor_change_sms', { enabled: true });
}, 240_000);

afterAll(async () => {
  await h.close();
});

const intake = (by: LoggedInAccount, mobile: string, nid: string | null) =>
  h.app.get(LeadIntakeService).intake(actorFor(by.id), {
    mobile,
    nationalId: nid,
    treatmentFieldCode: 'dental',
    channel: 'advisor',
    smsConsent: false,
  });

const rowOf = async (mobile: string) =>
  (
    await h.owner.query<Row>(
      `SELECT * FROM person_mobiles WHERE mobile = $1 ORDER BY created_at DESC LIMIT 1`,
      [mobile],
    )
  ).rows[0];

const accountOf = async (mobile: string) =>
  (
    await h.owner.query<Row>(
      `SELECT id, person_id FROM user_accounts WHERE kind = 'patient' AND mobile = $1`,
      [mobile],
    )
  ).rows[0];

/** A patient who logged in (a proved mobile) with an application in review and a national ID. */
async function victim() {
  const { patient, applicationId } = await w.inReview();
  const nid = nationalId();
  // The advisor's intake fills the national ID the Person lacked (never overwrites).
  await intake(advisor, patient.mobile, nid);
  const personId = (await accountOf(patient.mobile))?.['person_id'] as string;
  expect(personId).toBeTruthy();
  return { patient, applicationId, nid, personId };
}

/** Someone else's mobile added to the victim's Person by an advisor: pending. */
async function addPending(nid: string, by = advisor) {
  const mobile = newMobile();
  await intake(by, mobile, nid);
  const row = await rowOf(mobile);
  expect(row?.['status']).toBe('pending');
  return { mobile, id: row?.['id'] as string };
}

const personConsumer = () =>
  new PersonMobileNoticeConsumer(
    { register: () => undefined },
    h.app.get<PersonDirectory>(PERSON_DIRECTORY),
    h.app.get<AuditLog>(AUDIT_LOG),
    h.app.get(FactorNotices),
  );
const factorConsumer = () =>
  new FactorNoticeConsumer(
    { register: () => undefined },
    h.app.get<ConfigPort>(CONFIG),
    h.app.get<NotificationsPort>(NOTIFICATIONS),
    h.app.get<AuditLog>(AUDIT_LOG),
  );

async function outboxOf(type: string, aggregateId: string): Promise<EventEnvelope[]> {
  const { rows } = await h.owner.query<Row>(
    `SELECT id, event_type, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
      WHERE event_type = $1 AND aggregate_id = $2 ORDER BY created_at, id`,
    [type, aggregateId],
  );
  return rows.map((r) => ({
    id: r['id'] as string,
    type: r['event_type'] as string,
    aggregateType: r['aggregate_type'] as string,
    aggregateId: r['aggregate_id'] as string,
    payload: r['payload'],
    occurredAt: (r['created_at'] as Date).toISOString(),
  }));
}

/** What the worker does with the Person's events, then with the notices they made. */
async function deliver(personId: string) {
  const seen = new Set<string>();
  for (const e of await outboxOf('lead.person_mobile_changed', personId)) {
    await db.transaction((tx) => personConsumer().handle(e, tx));
    seen.add(e.id);
  }
  const { rows } = await h.owner.query<Row>(
    `SELECT DISTINCT account_id FROM factor_change_notices WHERE event LIKE 'patient_mobile_%'`,
  );
  for (const r of rows) {
    for (const e of await outboxOf('identity.factor_changed', r['account_id'] as string)) {
      await db.transaction((tx) => factorConsumer().handle(e, tx));
    }
  }
  return seen.size;
}

const smsTo = async (mobile: string) =>
  (
    await h.owner.query<Row>(
      `SELECT t.code, d.text FROM sms_dispatches d JOIN sms_templates t ON t.id = d.template_id
        WHERE d.mobile = $1 ORDER BY d.created_at`,
      [mobile],
    )
  ).rows;

const decisions = async (personMobileId: string) =>
  (
    await h.owner.query<Row>(
      `SELECT decision, method, decided_by, reason, evidence FROM person_mobile_decisions
        WHERE person_mobile_id = $1 ORDER BY created_at`,
      [personMobileId],
    )
  ).rows;

/**
 * Every list of a patient's own records, and the victim's application asked for by its id,
 * as this login sees them: refused (403 or 404), or answered without the victim's records.
 */
const patientPaths = (applicationId: string) => [
  '/me/credit-applications',
  `/me/credit-applications/${applicationId}`,
  '/me/proformas',
  '/me/contracts',
  '/booking/me/appointments',
  '/me/tickets',
  '/me/guarantees',
  `/me/completion/${applicationId}`,
  `/me/repayment/schedules?creditApplicationId=${applicationId}`,
];

async function patientSees(p: Patient, applicationId: string): Promise<string> {
  let all = '';
  for (const path of patientPaths(applicationId)) {
    const res = await w.as(p, 'GET', path);
    expect([200, 403, 404], path).toContain(res.status);
    if (res.status === 200) all += JSON.stringify(res.body);
  }
  return all;
}

describe('a mobile added to an existing Person by national ID is pending (م۵)', () => {
  it('advisor intake: pending for 30 days, audited; the proved mobile told at once, no number in the text', async () => {
    const v = await victim();
    const before = Date.now();
    const { mobile, id } = await addPending(v.nid);
    const row = await rowOf(mobile);
    expect(row).toMatchObject({ added_via: 'intake', added_by: advisor.id, proved_at: null });
    const days = ((row?.['pending_expires_at'] as Date).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
    const { rows: audit } = await h.owner.query<Row>(
      `SELECT after FROM audit_events WHERE action = 'lead.person_mobile_added' AND entity_id = $1`,
      [v.personId],
    );
    expect(audit[0]?.['after']).toMatchObject({ personMobileId: id, status: 'pending' });
    expect(JSON.stringify(audit)).not.toContain(mobile);

    expect(await deliver(v.personId)).toBe(1);
    const told = await smsTo(v.patient.mobile);
    expect(told.map((t) => t['code'])).toContain('identity.factor.patient_mobile_added');
    const text = told.find((t) => t['code'] === 'identity.factor.patient_mobile_added')?.['text'];
    expect(String(text)).not.toMatch(/[0-9۰-۹]{4,}/);
    // The pending mobile itself is told nothing.
    expect(await smsTo(mobile)).toEqual([]);
    // The event carries row ids only.
    const [event] = await outboxOf('lead.person_mobile_changed', v.personId);
    expect(JSON.stringify(event?.payload)).not.toContain(mobile);
    expect(JSON.stringify(event?.payload)).not.toContain(v.patient.mobile);
  });

  it('the Excel import: pending too', async () => {
    const v = await victim();
    await setConfig('lead.excel_import_enabled', true);
    const mobile = newMobile();
    const form = new FormData();
    form.append(
      'file',
      new Blob([
        writeSheet([
          ['موبایل', 'نام', 'کد ملی', 'کد فیلد درمان', 'کد شهر', 'رضایت پیامک'],
          [mobile, 'دیگری', v.nid, 'dental', 'tehran', ''],
        ]),
      ]),
      'leads.xlsx',
    );
    const preview = await fetch(`${h.baseUrl}/lead/imports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manager.access}`, 'x-forwarded-for': newIp() },
      body: form,
    });
    const batchId = ((await preview.json()) as Body)['batchId'] as string;
    expect((await w.staff(manager, 'POST', `/lead/imports/${batchId}/commit`, reason)).status).toBe(
      200,
    );
    await h.app.get(LeadImportProcessor).process(batchId);
    expect(await rowOf(mobile)).toMatchObject({
      status: 'pending',
      added_via: 'import',
      person_id: v.personId,
    });
  });

  it('a credit transfer recipient: refused, never added; a pending mobile refused too', async () => {
    const v = await victim();
    const leads = h.app.get<LeadCases>(LEAD_CASES);
    const fresh = newMobile();
    await expect(
      db.transaction((tx) =>
        leads.recipientPerson(tx, actorFor(advisor.id), {
          mobile: fresh,
          nationalId: v.nid,
          name: 'گیرنده',
        }),
      ),
    ).rejects.toMatchObject({ response: { error: 'recipient_mobile_mismatch' } });
    expect(await rowOf(fresh)).toBeUndefined();
    const pending = await addPending(v.nid);
    await expect(
      db.transaction((tx) =>
        leads.recipientPerson(tx, actorFor(advisor.id), {
          mobile: pending.mobile,
          nationalId: nationalId(),
          name: 'گیرنده',
        }),
      ),
    ).rejects.toMatchObject({ response: { error: 'recipient_mobile_pending' } });
  });
});

describe('a pending mobile gives no access, by any path that reads person_mobiles', () => {
  it('OTP login (findOrCreateByMobile/linkLogin): proved, but linked to nobody; every patient list empty', async () => {
    const v = await victim();
    const { mobile } = await addPending(v.nid);
    const intruder = await w.patient(mobile);
    expect(await accountOf(mobile)).toMatchObject({ person_id: null });
    // The login proved the mobile (its holder has it), still pending.
    expect(await rowOf(mobile)).toMatchObject({ status: 'pending' });
    expect((await rowOf(mobile))?.['proved_at']).not.toBeNull();
    const seen = await patientSees(intruder, v.applicationId);
    expect(seen).not.toContain(v.applicationId);
    expect(seen).not.toContain(v.personId);
    const mine = await w.as(intruder, 'GET', '/person-mobiles/mine');
    expect(mine.body).toEqual({ ownMobilePending: true, awaitingDecision: [] });
    // Nor does the directory hand the Person out to anyone else.
    const directory = h.app.get<PersonDirectory>(PERSON_DIRECTORY);
    expect(await directory.findOrCreateByMobile(mobile)).toEqual({ personId: null });
    // The owner's own view still works.
    expect(await patientSees(v.patient, v.applicationId)).toContain(v.applicationId);
  });

  it("LEAD_CASES: no Person by it (a ticket on a caller's behalf), no booking of the patient's own; a block still reaches it", async () => {
    const v = await victim();
    const { mobile } = await addPending(v.nid);
    const leads = h.app.get<LeadCases>(LEAD_CASES);
    expect(await leads.personByMobile(mobile)).toBeNull();
    const settings = await leads.intakeSettings();
    const booked = await db.transaction((tx) =>
      leads.openForBooking(
        tx,
        actorFor(advisor.id),
        { mobile, treatmentFieldCode: 'dental', cityCode: 'tehran', channel: 'app' },
        settings,
      ),
    );
    expect(booked).toEqual({ kind: 'refused' });
    // A block is a restriction: it reaches a pending mobile as well.
    await w.staff(manager, 'POST', `/lead/persons/${v.personId}/block`, {
      kind: 'abuse',
      reason: 'آزمون مسدودسازی',
    });
    expect(await leads.standingOf(mobile)).toBe('abuse');
  });

  it('credit: a pending mobile borrows for nobody', async () => {
    const v = await victim();
    const { mobile } = await addPending(v.nid);
    const other = await w.patient();
    const { proformaId } = await w.confirmedProforma(other);
    const made = await w.as(other, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: PLAN.code,
      installmentCount: 12,
      borrowerMobile: mobile,
    });
    expect(made.status).toBe(409);
    expect(made.body['error']).toBe('person_mobile_pending');
  });

  it('staff person view: approved mobiles in `mobiles`, the pending one apart', async () => {
    const v = await victim();
    const { mobile, id } = await addPending(v.nid);
    const leads = h.app.get<LeadCases>(LEAD_CASES);
    const { rows } = await h.owner.query<Row>(
      `SELECT id FROM cases WHERE person_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [v.personId],
    );
    const res = await w.staff(manager, 'GET', `/lead/cases/${rows[0]?.['id'] as string}`);
    expect(res.status).toBe(200);
    const person = res.body['person'] as Body;
    expect(person['mobiles']).toEqual([v.patient.mobile]);
    expect(person['pendingMobiles']).toMatchObject([{ id, mobile }]);
    expect(await leads.mobileOf(v.personId)).toBe(v.patient.mobile);
  });
});

describe('a pending mobile gets no SMS (mobileOf: every SMS to a Person)', () => {
  it('installment reminder and overdue notice go to the approved mobile, even with an older pending row', async () => {
    const { patient, applicationId } = await steps.approved();
    await steps.complete(patient, applicationId);
    const purseId = await steps.fund(applicationId);
    const nid = nationalId();
    await intake(advisor, patient.mobile, nid);
    const { mobile, id } = await addPending(nid);
    // The worst order for a "first mobile" rule: the pending row made the oldest (fixture).
    await h.owner.query(
      `UPDATE person_mobiles SET created_at = created_at - interval '10 years' WHERE id = $1`,
      [id],
    );
    const personId = (await accountOf(patient.mobile))?.['person_id'] as string;
    expect(await h.app.get<LeadCases>(LEAD_CASES).mobileOf(personId)).toBe(patient.mobile);

    const repayment = h.app.get(RepaymentService);
    const { rows } = await h.owner.query<Row>(
      'SELECT schedule_id FROM funding_requests WHERE purse_id = $1',
      [purseId],
    );
    const first = (await repayment.schedule(rows[0]?.['schedule_id'] as string)).installments[0];
    if (!first) throw new Error('no installment');
    const at = (days: number) => {
      const d = new Date(`${first.dueOn}T08:30:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d;
    };
    await repayment.runReminders(at(-3));
    await repayment.runReminders(at(1));
    const { rows: sent } = await h.owner.query<Row>(
      `SELECT DISTINCT mobile FROM sms_dispatches WHERE starts_with(idempotency_key, $1)`,
      [`repayment:reminder:${first.id}:`],
    );
    expect(sent).toEqual([{ mobile: patient.mobile }]);
    expect(await smsTo(mobile)).toEqual([]);
  });
});

describe('(الف) the holder of a proved mobile decides in their own panel', () => {
  it('sees it by the last four digits; approves; the new mobile is linked and sees the records', async () => {
    const v = await victim();
    const { mobile, id } = await addPending(v.nid);
    const intruder = await w.patient(mobile);
    const mine = await w.as(v.patient, 'GET', '/person-mobiles/mine');
    expect(mine.body).toMatchObject({
      ownMobilePending: false,
      awaitingDecision: [{ id, mobileLast4: mobile.slice(-4) }],
    });
    expect(JSON.stringify(mine.body)).not.toContain(mobile);
    // Another patient: not found (IDOR), nothing decided.
    const stranger = await w.patient();
    const idor = await w.as(stranger, 'POST', `/person-mobiles/${id}/approve`);
    expect(idor.status).toBe(404);
    // The pending mobile cannot approve itself.
    expect((await w.as(intruder, 'POST', `/person-mobiles/${id}/approve`)).status).toBe(404);
    // Staff are not patients here.
    expect((await w.staff(approverB, 'POST', `/person-mobiles/${id}/approve`)).status).toBe(403);

    const ok = await w.as(v.patient, 'POST', `/person-mobiles/${id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id, decision: 'approved' });
    expect(await rowOf(mobile)).toMatchObject({ status: 'active' });
    expect(await decisions(id)).toEqual([
      expect.objectContaining({
        decision: 'approved',
        method: 'owner_panel',
        decided_by: v.patient.id,
      }),
    ]);
    // Twice: nothing pending any more.
    expect((await w.as(v.patient, 'POST', `/person-mobiles/${id}/approve`)).status).toBe(404);

    await deliver(v.personId);
    expect(await accountOf(mobile)).toMatchObject({ person_id: v.personId });
    expect(await patientSees(intruder, v.applicationId)).toContain(v.applicationId);
    expect((await smsTo(v.patient.mobile)).map((t) => t['code'])).toContain(
      'identity.factor.patient_mobile_approved',
    );
  });

  it('refuses: soft-deleted, recorded, told; the mobile then gets a Person of its own', async () => {
    const v = await victim();
    const { mobile, id } = await addPending(v.nid);
    const res = await w.as(v.patient, 'POST', `/person-mobiles/${id}/reject`);
    expect(res.body).toEqual({ id, decision: 'rejected' });
    const row = (
      await h.owner.query<Row>('SELECT status, deleted_at FROM person_mobiles WHERE id = $1', [id])
    ).rows[0];
    expect(row?.['deleted_at']).not.toBeNull();
    expect(row?.['status']).toBe('rejected');
    expect(await decisions(id)).toMatchObject([{ decision: 'rejected', method: 'owner_panel' }]);
    await deliver(v.personId);
    expect((await smsTo(v.patient.mobile)).map((t) => t['code'])).toContain(
      'identity.factor.patient_mobile_rejected',
    );
    await w.patient(mobile);
    const own = (await accountOf(mobile))?.['person_id'];
    expect(own).toBeTruthy();
    expect(own).not.toBe(v.personId);
  });
});

describe('(ب) staff with lead.approve_person_mobile, with evidence, by two people', () => {
  it('permission, four eyes, evidence and R1; the queue says whether (الف) is possible', async () => {
    const v = await victim();
    const { id } = await addPending(v.nid, approverA);
    const evidence = { reason: 'تماس با صاحب حساب', evidence: 'کارت ملی حضوری دیده شد' };
    const second = { reason: 'مدرک نفر اول بررسی شد' };
    expect((await w.staff(plain, 'GET', '/lead/person-mobiles/pending')).status).toBe(403);
    expect(
      (await w.staff(plain, 'POST', `/lead/person-mobiles/${id}/propose`, evidence)).status,
    ).toBe(403);
    expect(
      (await w.staff(plain, 'POST', `/lead/person-mobiles/${id}/approve`, second)).status,
    ).toBe(403);
    const queue = await w.staff(approverB, 'GET', '/lead/person-mobiles/pending');
    expect(queue.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, hasProvedMobile: true })]),
    );
    const own = await w.staff(approverA, 'POST', `/lead/person-mobiles/${id}/propose`, evidence);
    expect(own.status).toBe(403);
    expect(own.body['error']).toBe('added_by_same_account');
    const bare = await w.staff(approverB, 'POST', `/lead/person-mobiles/${id}/propose`, reason);
    expect(bare.status).toBe(400);

    await setConfig('identity.reauth', { enabled: true, windowSeconds: 300 });
    try {
      for (const action of ['propose', 'approve'] as const) {
        const stale = await w.staff(
          approverB,
          'POST',
          `/lead/person-mobiles/${id}/${action}`,
          action === 'propose' ? evidence : second,
        );
        expect(stale.status).toBe(403);
        expect(stale.body['error']).toBe('reauth_required');
      }
    } finally {
      await setConfig('identity.reauth', { enabled: false, windowSeconds: 300 });
    }
    const proposed = await w.staff(
      approverB,
      'POST',
      `/lead/person-mobiles/${id}/propose`,
      evidence,
    );
    expect(proposed.status).toBe(200);
    expect(proposed.body).toEqual({ id, proposedBy: approverB.id });
    const ok = await w.staff(approverC, 'POST', `/lead/person-mobiles/${id}/approve`, second);
    expect(ok.status).toBe(200);
    expect(await decisions(id)).toEqual([
      {
        decision: 'approved',
        method: 'staff',
        decided_by: approverC.id,
        reason: second.reason,
        evidence: evidence.evidence,
      },
    ]);
    const { rows: named } = await h.owner.query<Row>(
      `SELECT d.proposal_id = p.id AS named, p.proposed_by FROM person_mobile_decisions d
         JOIN person_mobile_proposals p ON p.person_mobile_id = d.person_mobile_id
        WHERE d.person_mobile_id = $1`,
      [id],
    );
    expect(named).toEqual([{ named: true, proposed_by: approverB.id }]);
  });

  it('a Person with no proved mobile: no notice (audited), staff only', async () => {
    const nid = nationalId();
    const first = newMobile();
    await intake(advisor, first, nid);
    const { id } = await addPending(nid);
    const personId = (await rowOf(first))?.['person_id'] as string;
    const { rows } = await h.owner.query<Row>(
      `SELECT after FROM audit_events WHERE action = 'lead.person_mobile_notice_skipped' AND entity_id = $1`,
      [personId],
    );
    expect(rows[0]?.['after']).toMatchObject({ change: 'added', reason: 'no_proved_mobile' });
    expect(await outboxOf('lead.person_mobile_changed', personId)).toEqual([]);
    const queue = await w.staff(approverB, 'GET', '/lead/person-mobiles/pending');
    expect(queue.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, hasProvedMobile: false })]),
    );
  });
});

describe('the deadline (lead.person_mobile_pending_days, owner: 30)', () => {
  it('past it: refused by the job, recorded and told; the owner can no longer decide', async () => {
    const v = await victim();
    const { id } = await addPending(v.nid);
    const late = await addPending(v.nid);
    await h.owner.query(
      `UPDATE person_mobiles SET pending_expires_at = now() - interval '1 minute'
        WHERE id = ANY($1::uuid[])`,
      [[id, late.id]],
    );
    const owner = await w.as(v.patient, 'POST', `/person-mobiles/${late.id}/approve`);
    expect(owner.status).toBe(409);
    expect(owner.body['error']).toBe('person_mobile_expired');
    const result = await h.app.get(PersonMobileApprovalService).expireOverdue();
    expect(result.rejected).toBeGreaterThanOrEqual(2);
    expect(await decisions(id)).toMatchObject([
      { decision: 'rejected', method: 'expiry', decided_by: null },
    ]);
    expect(
      (await h.owner.query<Row>('SELECT deleted_at FROM person_mobiles WHERE id = $1', [id]))
        .rows[0]?.['deleted_at'],
    ).not.toBeNull();
    await deliver(v.personId);
    expect(
      (await smsTo(v.patient.mobile)).filter(
        (t) => t['code'] === 'identity.factor.patient_mobile_rejected',
      ),
    ).toHaveLength(2);
    // Run again: nothing more.
    expect((await h.app.get(PersonMobileApprovalService).expireOverdue()).rejected).toBe(0);
  });
});

describe('merging Persons (owner: R1, different national IDs refused, R2)', () => {
  it('needs re-authentication; refuses two national IDs; tells the proved mobiles of both', async () => {
    const a = await victim();
    const b = await victim();
    const body = { survivorId: a.personId, mergedId: b.personId, ...reason };
    // Two national IDs: two humans.
    const twoIds = await w.staff(manager, 'POST', '/lead/person-merges', body);
    expect(twoIds.status).toBe(409);
    expect(twoIds.body['error']).toBe('national_id_conflict');

    // A Person with no case (as a login makes one), so no two open cases meet.
    const lone = newMobile();
    const loneId = (await h.app.get<PersonDirectory>(PERSON_DIRECTORY).findOrCreateByMobile(lone))
      .personId as string;
    await setConfig('identity.reauth', { enabled: true, windowSeconds: 300 });
    try {
      const stale = await w.staff(manager, 'POST', '/lead/person-merges', {
        survivorId: a.personId,
        mergedId: loneId,
        ...reason,
      });
      expect(stale.status).toBe(403);
      expect(stale.body['error']).toBe('reauth_required');
    } finally {
      await setConfig('identity.reauth', { enabled: false, windowSeconds: 300 });
    }
    const merged = await w.staff(manager, 'POST', '/lead/person-merges', {
      survivorId: a.personId,
      mergedId: loneId,
      ...reason,
    });
    expect(merged.status).toBe(201);
    // The lone Person has no national ID, so its mobile is re-issued pending (0081 second
    // approval) and the survivor's proved mobile is told of that row.
    const [event] = await outboxOf('lead.person_mobile_changed', loneId);
    expect(event?.payload).toMatchObject({
      change: 'added',
      personMobileId: (await rowOf(lone))?.['id'],
    });
    await deliver(loneId);
    expect((await smsTo(a.patient.mobile)).map((t) => t['code'])).toContain(
      'identity.factor.patient_mobile_added',
    );
  });
});

describe('person_mobile_decisions is append-only', () => {
  it('the application role may not change or remove a decision', async () => {
    const v = await victim();
    const { id } = await addPending(v.nid);
    await w.as(v.patient, 'POST', `/person-mobiles/${id}/reject`);
    await expect(
      db.execute(
        sql`UPDATE person_mobile_decisions SET reason = 'x' WHERE person_mobile_id = ${id}`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM person_mobile_decisions WHERE person_mobile_id = ${id}`),
    ).rejects.toThrow();
    expect(await decisions(id)).toHaveLength(1);
  });
});

/** What the database said refusing it: the code and message of the cause drizzle wraps. */
async function refusal(q: Promise<unknown>): Promise<string> {
  try {
    await q;
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string; message?: string } };
    return `${err.cause?.code ?? ''} ${err.cause?.message ?? err.message ?? ''}`;
  }
  throw new Error('not refused');
}

describe('person_mobiles.status: no default, and only forward (owner, 0081 second approval)', () => {
  it('an insert that does not say its status is refused (sepehr_app)', async () => {
    const v = await victim();
    const said = await refusal(
      db.execute(
        sql`INSERT INTO person_mobiles (person_id, mobile) VALUES (${v.personId}, ${newMobile()})`,
      ),
    );
    expect(said).toMatch(/23502|null value in column "status"/);
    // Every row the service writes says it: the login's own active, the added one pending.
    expect(await rowOf(v.patient.mobile)).toMatchObject({ status: 'active' });
    const { mobile } = await addPending(v.nid);
    expect(await rowOf(mobile)).toMatchObject({ status: 'pending' });
  });

  it('status leaves pending only, for active or rejected; nothing else (sepehr_app)', async () => {
    const v = await victim();
    const active = (await rowOf(v.patient.mobile))?.['id'] as string;
    const status = (id: string, to: string) =>
      refusal(db.execute(sql`UPDATE person_mobiles SET status = ${to} WHERE id = ${id}`));
    expect(await status(active, 'pending')).toMatch(/status may not change from active to pending/);
    expect(await status(active, 'rejected')).toMatch(
      /status may not change from active to rejected/,
    );

    const toActive = await addPending(v.nid);
    await db.execute(sql`UPDATE person_mobiles SET status = 'active' WHERE id = ${toActive.id}`);
    expect(await status(toActive.id, 'pending')).toMatch(/from active to pending/);

    const toRejected = await addPending(v.nid);
    // Rejected is soft-deleted too (person_mobiles_rejected_deleted_check).
    expect(await status(toRejected.id, 'rejected')).toMatch(/23514|rejected_deleted_check/);
    await db.execute(
      sql`UPDATE person_mobiles SET status = 'rejected', deleted_at = now() WHERE id = ${toRejected.id}`,
    );
    expect(await status(toRejected.id, 'active')).toMatch(/from rejected to active/);
    expect(await status(toRejected.id, 'pending')).toMatch(/from rejected to pending/);
    // The other column of the grant still changes (deleted_at, 0015).
    await db.execute(sql`UPDATE person_mobiles SET deleted_at = now() WHERE id = ${active}`);
  });

  it('proved_at is set once (sepehr_app)', async () => {
    const v = await victim();
    const { mobile, id } = await addPending(v.nid);
    expect((await rowOf(mobile))?.['proved_at']).toBeNull();
    // Null to a time: what a first OTP login does.
    await db.execute(sql`UPDATE person_mobiles SET proved_at = now() WHERE id = ${id}`);
    const set = (to: Date | null) =>
      refusal(db.execute(sql`UPDATE person_mobiles SET proved_at = ${to} WHERE id = ${id}`));
    expect(await set(new Date('2020-01-01T00:00:00Z'))).toMatch(/proved_at is set once/);
    expect(await set(null)).toMatch(/proved_at is set once/);
    const proved = (await rowOf(v.patient.mobile))?.['id'] as string;
    expect(
      await refusal(
        db.execute(sql`UPDATE person_mobiles SET proved_at = now() WHERE id = ${proved}`),
      ),
    ).toMatch(/proved_at is set once/);
    // A later login keeps the first (what otp-login hands the directory; a second OTP request
    // this soon is rate-limited).
    const first = (await rowOf(v.patient.mobile))?.['proved_at'] as Date;
    await h.app.get<PersonDirectory>(PERSON_DIRECTORY).linkLogin(v.patient.mobile, new Date());
    expect((await rowOf(v.patient.mobile))?.['proved_at']).toEqual(first);
  });
});

describe('a merge, and its revert, re-issue the moved mobiles pending (owner, 0081 second approval)', () => {
  it("the merged Person's mobiles wait for the survivor's approval; its linked login sees nothing until then; revert waits again", async () => {
    const a = await victim();
    const loneMobile = newMobile();
    const lone = await w.patient(loneMobile);
    const loneOld = await rowOf(loneMobile);
    const loneId = loneOld?.['person_id'] as string;
    expect(loneOld).toMatchObject({ status: 'active' });

    const merged = await w.staff(manager, 'POST', '/lead/person-merges', {
      survivorId: a.personId,
      mergedId: loneId,
      ...reason,
    });
    expect(merged.status).toBe(201);
    const mergeId = merged.body['mergeId'] as string;
    // The old row retired, the mobile again on the same Person, pending, its proof kept.
    const reissued = await rowOf(loneMobile);
    expect(reissued).toMatchObject({
      status: 'pending',
      added_via: 'merge',
      added_by: manager.id,
      person_id: loneId,
      deleted_at: null,
    });
    expect(reissued?.['id']).not.toBe(loneOld?.['id']);
    expect(reissued?.['proved_at']).toEqual(loneOld?.['proved_at']);
    const days = ((reissued?.['pending_expires_at'] as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const old = (
      await h.owner.query<Row>('SELECT status, deleted_at FROM person_mobiles WHERE id = $1', [
        loneOld?.['id'],
      ])
    ).rows[0];
    expect(old?.['status']).toBe('active');
    expect(old?.['deleted_at']).not.toBeNull();

    // The merged login, linked before, sees nothing of the survivor.
    expect(await patientSees(lone, a.applicationId)).not.toContain(a.applicationId);
    expect((await w.as(lone, 'GET', '/person-mobiles/mine')).body).toEqual({
      ownMobilePending: true,
      awaitingDecision: [],
    });
    // The survivor's proved mobile is told, and decides; the pending one is told nothing.
    const [event] = await outboxOf('lead.person_mobile_changed', loneId);
    expect(event?.payload).toMatchObject({ change: 'added', personMobileId: reissued?.['id'] });
    await deliver(loneId);
    expect((await smsTo(a.patient.mobile)).map((t) => t['code'])).toContain(
      'identity.factor.patient_mobile_added',
    );
    expect(await smsTo(loneMobile)).toEqual([]);
    const mine = await w.as(a.patient, 'GET', '/person-mobiles/mine');
    expect(mine.body['awaitingDecision']).toEqual([
      expect.objectContaining({ id: reissued?.['id'], mobileLast4: loneMobile.slice(-4) }),
    ]);
    const ok = await w.as(
      a.patient,
      'POST',
      `/person-mobiles/${reissued?.['id'] as string}/approve`,
    );
    expect(ok.status).toBe(200);
    expect(await patientSees(lone, a.applicationId)).toContain(a.applicationId);

    // Revert: the same rule backwards; the Person alone again has no proved approved mobile.
    const reverted = await w.staff(
      manager,
      'POST',
      `/lead/person-merges/${mergeId}/revert`,
      reason,
    );
    expect(reverted.status).toBe(200);
    const again = await rowOf(loneMobile);
    expect(again).toMatchObject({ status: 'pending', added_via: 'merge', person_id: loneId });
    expect(again?.['id']).not.toBe(reissued?.['id']);
    expect(await patientSees(lone, a.applicationId)).not.toContain(a.applicationId);
    expect((await w.as(a.patient, 'GET', '/person-mobiles/mine')).body).toEqual({
      ownMobilePending: false,
      awaitingDecision: [],
    });
    const queue = await w.staff(approverB, 'GET', '/lead/person-mobiles/pending');
    expect(queue.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: again?.['id'], hasProvedMobile: false }),
      ]),
    );
  });

  it('a merge-moved mobile refused: the linked login sees nothing, and a later intake of it gives nothing back', async () => {
    const a = await victim();
    const loneMobile = newMobile();
    const lone = await w.patient(loneMobile);
    const loneId = (await rowOf(loneMobile))?.['person_id'] as string;
    const merged = await w.staff(manager, 'POST', '/lead/person-merges', {
      survivorId: a.personId,
      mergedId: loneId,
      ...reason,
    });
    expect(merged.status).toBe(201);
    const pending = (await rowOf(loneMobile))?.['id'] as string;
    expect((await w.as(a.patient, 'POST', `/person-mobiles/${pending}/reject`)).status).toBe(200);
    expect(await rowOf(loneMobile)).toMatchObject({ status: 'rejected' });
    expect(await decisions(pending)).toMatchObject([
      { decision: 'rejected', method: 'owner_panel' },
    ]);
    expect(await patientSees(lone, a.applicationId)).not.toContain(a.applicationId);
    // The mobile, free again, gets a Person of its own from an intake; the old link still
    // gives the survivor's records to nobody.
    await intake(advisor, loneMobile, null);
    expect(await rowOf(loneMobile)).toMatchObject({ status: 'active' });
    expect(await patientSees(lone, a.applicationId)).not.toContain(a.applicationId);
  });
});

describe('an import cancelled refuses the mobiles it added pending (owner, 0081 second approval)', () => {
  it('each recorded in person_mobile_decisions, the proved mobile told', async () => {
    const v = await victim();
    await setConfig('lead.excel_import_enabled', true);
    const mobile = newMobile();
    const form = new FormData();
    form.append(
      'file',
      new Blob([
        writeSheet([
          ['موبایل', 'نام', 'کد ملی', 'کد فیلد درمان', 'کد شهر', 'رضایت پیامک'],
          [mobile, 'دیگری', v.nid, 'dental', 'tehran', ''],
        ]),
      ]),
      'leads.xlsx',
    );
    const preview = await fetch(`${h.baseUrl}/lead/imports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manager.access}`, 'x-forwarded-for': newIp() },
      body: form,
    });
    const batchId = ((await preview.json()) as Body)['batchId'] as string;
    await w.staff(manager, 'POST', `/lead/imports/${batchId}/commit`, reason);
    await h.app.get(LeadImportProcessor).process(batchId);
    const row = await rowOf(mobile);
    expect(row).toMatchObject({ status: 'pending', import_batch_id: batchId });
    const id = row?.['id'] as string;
    // An intake's pending mobile of the same Person is not the batch's: it stays.
    const other = await addPending(v.nid);

    const cancelled = await w.staff(manager, 'POST', `/lead/imports/${batchId}/cancel`, {
      reason: 'دسته اشتباه بود',
    });
    expect(cancelled.status).toBe(200);
    const after = (
      await h.owner.query<Row>('SELECT status, deleted_at FROM person_mobiles WHERE id = $1', [id])
    ).rows[0];
    expect(after?.['status']).toBe('rejected');
    expect(after?.['deleted_at']).not.toBeNull();
    expect(await decisions(id)).toEqual([
      {
        decision: 'rejected',
        method: 'import_cancelled',
        decided_by: manager.id,
        reason: 'دسته اشتباه بود',
        evidence: null,
      },
    ]);
    expect(await rowOf(other.mobile)).toMatchObject({ status: 'pending' });
    const { rows: audit } = await h.owner.query<Row>(
      `SELECT after FROM audit_events WHERE action = 'lead.import_cancelled' AND entity_id = $1`,
      [batchId],
    );
    expect(audit[0]?.['after']).toMatchObject({ rejectedMobiles: 1 });
    await deliver(v.personId);
    expect((await smsTo(v.patient.mobile)).map((t) => t['code'])).toContain(
      'identity.factor.patient_mobile_rejected',
    );
  });
});

describe('who decides (الف) and who is told (R2): active, proved and live only (owner, 1405/07/19)', () => {
  it('an active mobile with no proved_at (staff entered it, nobody logged in): neither told nor able to approve', async () => {
    const nid = nationalId();
    const first = newMobile();
    await intake(advisor, first, nid);
    const unproved = await rowOf(first);
    expect(unproved).toMatchObject({ status: 'active', proved_at: null });
    const personId = unproved?.['person_id'] as string;
    // A patient session for that mobile without the OTP proof (fixture: an account moved to it).
    const holder = await w.patient();
    await h.owner.query(`UPDATE user_accounts SET mobile = $1, person_id = $2 WHERE id = $3`, [
      first,
      personId,
      holder.id,
    ]);
    expect((await rowOf(first))?.['proved_at']).toBeNull();

    const { id } = await addPending(nid);
    // R2: not told; the audit says nobody was.
    expect(await outboxOf('lead.person_mobile_changed', personId)).toEqual([]);
    const { rows } = await h.owner.query<Row>(
      `SELECT after FROM audit_events WHERE action = 'lead.person_mobile_notice_skipped' AND entity_id = $1`,
      [personId],
    );
    expect(rows[0]?.['after']).toMatchObject({ reason: 'no_proved_mobile' });
    expect(await smsTo(first)).toEqual([]);
    // (الف): sees nothing to decide, and may not decide.
    expect((await w.as(holder, 'GET', '/person-mobiles/mine')).body).toEqual({
      ownMobilePending: false,
      awaitingDecision: [],
    });
    expect((await w.as(holder, 'POST', `/person-mobiles/${id}/approve`)).status).toBe(404);
    expect((await w.as(holder, 'POST', `/person-mobiles/${id}/reject`)).status).toBe(404);
    expect(await rowOf(first)).toMatchObject({ status: 'active' });
    expect(await decisions(id)).toEqual([]);
  });

  it('a pending row with a proved_at carried over by a merge: neither told nor able to approve', async () => {
    const a = await victim();
    const loneMobile = newMobile();
    const lone = await w.patient(loneMobile);
    const loneId = (await rowOf(loneMobile))?.['person_id'] as string;
    const merged = await w.staff(manager, 'POST', '/lead/person-merges', {
      survivorId: a.personId,
      mergedId: loneId,
      ...reason,
    });
    expect(merged.status).toBe(201);
    const carried = await rowOf(loneMobile);
    expect(carried).toMatchObject({ status: 'pending' });
    expect(carried?.['proved_at']).not.toBeNull();

    // Another mobile added to the survivor: the survivor's proved mobile is told, not lone's.
    const other = await addPending(a.nid);
    await deliver(a.personId);
    await deliver(loneId);
    expect((await smsTo(a.patient.mobile)).map((t) => t['code'])).toContain(
      'identity.factor.patient_mobile_added',
    );
    expect(await smsTo(loneMobile)).toEqual([]);
    const { rows } = await h.owner.query<Row>(
      `SELECT payload FROM outbox_events WHERE event_type = 'lead.person_mobile_changed'
        AND payload->>'personMobileId' = $1`,
      [other.id],
    );
    expect(JSON.stringify(rows)).not.toContain(carried?.['id'] as string);

    expect((await w.as(lone, 'GET', '/person-mobiles/mine')).body).toEqual({
      ownMobilePending: true,
      awaitingDecision: [],
    });
    expect((await w.as(lone, 'POST', `/person-mobiles/${other.id}/approve`)).status).toBe(404);
    expect(await rowOf(other.mobile)).toMatchObject({ status: 'pending' });
    expect(await decisions(other.id)).toEqual([]);
  });
});

describe('a soft-deleted person_mobiles row stays deleted (trigger, owner 1405/07/19)', () => {
  it('deleted_at back to NULL is refused (sepehr_app); another time is not the question', async () => {
    const v = await victim();
    const { id } = await addPending(v.nid);
    await w.as(v.patient, 'POST', `/person-mobiles/${id}/reject`);
    expect(
      await refusal(db.execute(sql`UPDATE person_mobiles SET deleted_at = NULL WHERE id = ${id}`)),
    ).toMatch(/a deleted row stays deleted/);
    // Not with a status change either.
    expect(
      await refusal(
        db.execute(
          sql`UPDATE person_mobiles SET deleted_at = NULL, status = 'active' WHERE id = ${id}`,
        ),
      ),
    ).toMatch(/23514/);
    const row = (
      await h.owner.query<Row>('SELECT status, deleted_at FROM person_mobiles WHERE id = $1', [id])
    ).rows[0];
    expect(row?.['status']).toBe('rejected');
    expect(row?.['deleted_at']).not.toBeNull();
  });
});

/** A pending mobile of a Person made by an intake with another mobile: no booking needed. */
async function freshPending() {
  const nid = nationalId();
  await intake(advisor, newMobile(), nid);
  return addPending(nid);
}

describe('the staff queue masks the number; the whole number only on the decision page (owner 1405/07/23)', () => {
  it('the queue gives the last four digits only, never the number, in any field', async () => {
    const { id, mobile } = await freshPending();
    const queue = await w.staff(approverB, 'GET', '/lead/person-mobiles/pending');
    expect(queue.status).toBe(200);
    const item = (queue.body as unknown as Body[]).find((m) => m['id'] === id);
    expect(item).toMatchObject({ mobileLast4: mobile.slice(-4), proposal: null });
    expect(item).not.toHaveProperty('mobile');
    expect(JSON.stringify(queue.body)).not.toContain(mobile);
  });

  it('the decision page gives the whole number, and records each view of it', async () => {
    const { id, mobile } = await freshPending();
    const views = async () =>
      (
        await h.owner.query<Row>(
          `SELECT account_id FROM access_logs WHERE entity_type = 'person_mobile' AND entity_id = $1`,
          [id],
        )
      ).rows;
    expect(await views()).toEqual([]);
    const one = await w.staff(approverB, 'GET', `/lead/person-mobiles/${id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id, mobile, mobileLast4: mobile.slice(-4) });
    await w.staff(approverC, 'GET', `/lead/person-mobiles/${id}`);
    expect(await views()).toEqual([{ account_id: approverB.id }, { account_id: approverC.id }]);
  });

  it('no permission: 403 and no view recorded; an unknown or decided mobile: 404 (IDOR)', async () => {
    const { id } = await freshPending();
    expect((await w.staff(plain, 'GET', `/lead/person-mobiles/${id}`)).status).toBe(403);
    const unknown = '0195f000-0000-7000-8000-000000000000';
    expect((await w.staff(approverB, 'GET', `/lead/person-mobiles/${unknown}`)).status).toBe(404);
    expect(
      (
        await w.staff(approverB, 'POST', `/lead/person-mobiles/${unknown}/propose`, {
          reason: 'آزمون',
          evidence: 'کارت ملی',
        })
      ).status,
    ).toBe(404);
    // Decided (refused), it is no longer anybody's to see or decide.
    await w.staff(approverB, 'POST', `/lead/person-mobiles/${id}/reject`, reason);
    expect((await w.staff(approverB, 'GET', `/lead/person-mobiles/${id}`)).status).toBe(404);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM access_logs WHERE entity_type = 'person_mobile' AND entity_id = $1`,
      [id],
    );
    expect(rows[0]?.['n']).toBe(0);
  });
});

describe('two people approve (owner 1405/07/23): the first proposes, a second approves', () => {
  const evidence = { reason: 'تماس با صاحب حساب', evidence: 'کارت ملی حضوری دیده شد' };
  const second = { reason: 'مدرک نفر اول بررسی شد' };

  it('one person cannot: no proposal, no approval; the proposer does not approve their own', async () => {
    const { id, mobile } = await freshPending();
    const alone = await w.staff(approverB, 'POST', `/lead/person-mobiles/${id}/approve`, second);
    expect(alone.status).toBe(409);
    expect(alone.body['error']).toBe('person_mobile_not_proposed');
    expect(
      (await w.staff(approverB, 'POST', `/lead/person-mobiles/${id}/propose`, evidence)).status,
    ).toBe(200);
    const self = await w.staff(approverB, 'POST', `/lead/person-mobiles/${id}/approve`, second);
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('proposed_by_same_account');
    const again = await w.staff(approverC, 'POST', `/lead/person-mobiles/${id}/propose`, evidence);
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('person_mobile_already_proposed');
    expect(await decisions(id)).toEqual([]);
    expect((await rowOf(mobile))?.['status']).toBe('pending');
    // The queue says it waits for the second; the second approves.
    const queue = await w.staff(approverC, 'GET', '/lead/person-mobiles/pending');
    expect(
      (queue.body as unknown as Body[]).find((m) => m['id'] === id)?.['proposal'],
    ).toMatchObject({
      proposedBy: approverB.id,
    });
    const ok = await w.staff(approverC, 'POST', `/lead/person-mobiles/${id}/approve`, second);
    expect(ok.status).toBe(200);
    const { rows } = await h.owner.query<Row>(
      `SELECT action, actor_account_id FROM audit_events
        WHERE entity_type = 'person' AND action IN ('lead.person_mobile_proposed', 'lead.person_mobile_approved')
          AND after->>'personMobileId' = $1 ORDER BY seq`,
      [id],
    );
    expect(rows).toEqual([
      { action: 'lead.person_mobile_proposed', actor_account_id: approverB.id },
      { action: 'lead.person_mobile_approved', actor_account_id: approverC.id },
    ]);
  });

  it('refusing takes one, with or without a proposal', async () => {
    const { id } = await freshPending();
    await w.staff(approverB, 'POST', `/lead/person-mobiles/${id}/propose`, evidence);
    const no = await w.staff(approverB, 'POST', `/lead/person-mobiles/${id}/reject`, second);
    expect(no.status).toBe(200);
    expect(await decisions(id)).toMatchObject([{ decision: 'rejected', method: 'staff' }]);
  });

  it('the database refuses it too: a staff approval with no proposal, or by its proposer (sepehr_app)', async () => {
    const { id } = await freshPending();
    expect(
      await refusal(
        db.execute(sql`INSERT INTO person_mobile_decisions
          (person_mobile_id, decision, method, decided_by, reason, evidence)
          VALUES (${id}, 'approved', 'staff', ${approverC.id}, 'یک‌نفره', 'کارت ملی')`),
      ),
    ).toContain('person_mobile_decisions_staff_proposal_check');
    await w.staff(approverB, 'POST', `/lead/person-mobiles/${id}/propose`, evidence);
    expect(
      await refusal(
        db.execute(sql`INSERT INTO person_mobile_decisions
          (person_mobile_id, decision, method, decided_by, reason, evidence, proposal_id)
          SELECT ${id}, 'approved', 'staff', proposed_by, 'خودش', evidence, id
            FROM person_mobile_proposals WHERE person_mobile_id = ${id}`),
      ),
    ).toContain('the proposer does not approve their own proposal');
    await expect(
      db.execute(sql`UPDATE person_mobile_proposals SET proposed_by = ${approverC.id}
        WHERE person_mobile_id = ${id}`),
    ).rejects.toThrow();
  });

  it('the staff approvals before 0085, by one person, stay valid (the check is NOT VALID)', async () => {
    const { rows } = await h.owner.query<Row>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'person_mobile_decisions_staff_proposal_check'`,
    );
    expect(rows).toEqual([{ convalidated: false }]);
  });
});
