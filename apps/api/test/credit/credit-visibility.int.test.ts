import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/common/config/config.port';
import { LEAD_CASES } from '../../src/common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { CreditNotifier } from '../../src/modules/credit/credit-notifier';
import {
  grantRole,
  loggedInAccount,
  newMobile,
  startHarness,
  type Harness,
} from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from './world';

/**
 * Task 3-6 part C (doc 10 §6; doc 04 §4): what each role sees of a credit decision.
 * Doctors and advisors never receive a score or a rejection reason in any response
 * (§10 test 11); the patient sees state, amount and conditions; a staff member without
 * the field permissions gets the decision page without those fields; the guarantor still
 * sees only their own commitment; the patient's SMS never says why.
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;

const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};
const dal = { ...alef, job: 'none_stop' };
/** Any field or value that would give away a score or a reason. */
const SECRET =
  /"(borrowerGrade|grade|gradeLabel|creditScore|scoreBreakdown|total|criteriaScores|sufficiency|decisionReasons|reasonCode|reason|authority|amountLevel)"|"dal"|none_stop|شرط توقف/;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** Decided by the specialist and a second check; `before` runs on the case first. */
async function decided(
  raw: Body,
  outcome: 'approved' | 'rejected',
  before?: (caseId: string) => Promise<void>,
) {
  const manager = await w.role('credit_manager');
  const { patient, applicationId } = await w.inReview();
  const { rows } = await h.owner.query<Row>(
    'SELECT case_id FROM credit_applications WHERE id = $1',
    [applicationId],
  );
  const caseId = rows[0]?.['case_id'] as string;
  if (before) await before(caseId);
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw,
  });
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
  const proposed = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    outcome === 'approved'
      ? { outcome, reason: 'رتبه الف' }
      : { outcome, reasonCode: 'grade', reason: 'شرط توقف: شغل بدون مدرک' },
  );
  expect(proposed.status).toBe(201);
  const confirmed = await w.staff(
    manager,
    'POST',
    `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
  );
  expect(confirmed.status).toBe(201);
  return { patient, applicationId, caseId, manager };
}

describe('advisors, doctors and centers (doc 10 §10 test 11)', () => {
  it('see only «in review / approved / rejected», never a score or a reason', async () => {
    const advisor = await loggedInAccount(h, 'staff');
    await grantRole(h, advisor.id, 'advisor', { kind: 'own' });
    const stranger = await loggedInAccount(h, 'staff');
    await grantRole(h, stranger.id, 'advisor', { kind: 'own' });
    const strategy = await w.role('strategy_manager');
    // The advisor follows the case before the decision; a rejection closes it.
    const { applicationId, caseId } = await decided(dal, 'rejected', async (id) => {
      const assigned = await w.staff(strategy, 'POST', `/lead/cases/${id}/assignments`, {
        accountId: advisor.id,
        reason: 'پیگیری پرونده',
      });
      expect(assigned.status).toBe(201);
    });

    const ofAdvisor = await w.staff(advisor, 'GET', `/credit/cases/${caseId}/status`);
    expect(ofAdvisor.status).toBe(200);
    expect(ofAdvisor.body).toEqual({ caseId, state: 'rejected', nextAction: 'none' });
    const ofDoctor = await w.staff(w.doctor, 'GET', `/credit/cases/${caseId}/status`);
    expect(ofDoctor.status).toBe(200);
    expect(ofDoctor.body).toEqual({ caseId, state: 'rejected', nextAction: null });
    // Another advisor's case does not exist for them (rule 13).
    expect((await w.staff(stranger, 'GET', `/credit/cases/${caseId}/status`)).status).toBe(404);

    // No other credit endpoint answers them.
    for (const who of [advisor, w.doctor]) {
      for (const path of [
        `/credit/applications/${applicationId}`,
        `/credit/applications/${applicationId}/decision`,
        `/credit/applications/${applicationId}/scoring`,
      ]) {
        const res = await w.staff(who, 'GET', path);
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toMatch(/dal|none_stop|شرط توقف/);
      }
    }
    for (const res of [ofAdvisor, ofDoctor]) {
      expect(JSON.stringify(res.body)).not.toMatch(SECRET);
    }
  });

  it('the advisor sees the next step while in review', async () => {
    const { applicationId } = await w.inReview();
    const { rows } = await h.owner.query<Row>(
      'SELECT case_id FROM credit_applications WHERE id = $1',
      [applicationId],
    );
    const caseId = rows[0]?.['case_id'] as string;
    const advisor = await loggedInAccount(h, 'staff');
    await grantRole(h, advisor.id, 'advisor', { kind: 'own' });
    const strategy = await w.role('strategy_manager');
    await w.staff(strategy, 'POST', `/lead/cases/${caseId}/assignments`, {
      accountId: advisor.id,
      reason: 'پیگیری پرونده',
    });
    expect((await w.staff(advisor, 'GET', `/credit/cases/${caseId}/status`)).body).toEqual({
      caseId,
      state: 'in_review',
      nextAction: 'wait_for_review',
    });
  });

  it('after a handoff the status goes with the case: the previous advisor loses it', async () => {
    const { applicationId } = await w.inReview();
    const { rows } = await h.owner.query<Row>(
      'SELECT case_id FROM credit_applications WHERE id = $1',
      [applicationId],
    );
    const caseId = rows[0]?.['case_id'] as string;
    const [before, after] = [await loggedInAccount(h, 'staff'), await loggedInAccount(h, 'staff')];
    await grantRole(h, before.id, 'advisor', { kind: 'own' });
    await grantRole(h, after.id, 'advisor', { kind: 'own' });
    const strategy = await w.role('strategy_manager');
    for (const [who, reason] of [
      [before, 'پیگیری پرونده'],
      [after, 'انتقال به مشاور دیگر'],
    ] as const) {
      const assigned = await w.staff(strategy, 'POST', `/lead/cases/${caseId}/assignments`, {
        accountId: who.id,
        reason,
      });
      expect(assigned.status).toBe(201);
    }
    expect((await w.staff(before, 'GET', `/credit/cases/${caseId}/status`)).status).toBe(404);
    const ofNew = await w.staff(after, 'GET', `/credit/cases/${caseId}/status`);
    expect(ofNew.status).toBe(200);
    expect(ofNew.body).toMatchObject({ caseId, state: 'in_review' });
  });
});

describe('the field filter on the decision page (doc 04 §4)', () => {
  it('reasons and the engine’s words reach only those holding the permissions', async () => {
    const { applicationId, manager } = await decided(dal, 'rejected');
    const full = await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`);
    expect(full.body['creditScore']).toMatchObject({ borrowerGrade: 'dal' });
    const decision = (full.body['decisions'] as Body[])[0] ?? {};
    expect(decision['decisionReasons']).toMatchObject({ reasonCode: 'grade' });

    // Case completion reads applications, but not scores or reasons.
    const limited = await w.staff(
      w.completion,
      'GET',
      `/credit/applications/${applicationId}/decision`,
    );
    expect(limited.status).toBe(200);
    expect(limited.body).toMatchObject({ status: 'rejected', decision: 'rejected' });
    expect(limited.body).not.toHaveProperty('creditScore');
    const theirs = (limited.body['decisions'] as Body[])[0] ?? {};
    expect(theirs).not.toHaveProperty('decisionReasons');
    expect(theirs).not.toHaveProperty('creditScore');
    expect(JSON.stringify(limited.body)).not.toMatch(/dal|شرط توقف/);
  });
});

describe('the patient and the guarantor', () => {
  it('the patient sees state, amount and conditions; the SMS says what, never why', async () => {
    const { patient, applicationId } = await decided(alef, 'approved');
    const mine = await w.as(patient, 'GET', `/me/credit-applications/${applicationId}`);
    expect(mine.body).toMatchObject({
      status: 'approved',
      approvedAmountRial: '9600000',
      conditions: null,
    });
    expect(JSON.stringify(mine.body)).not.toMatch(SECRET);

    const rejected = await decided(dal, 'rejected');
    const theirs = await w.as(
      rejected.patient,
      'GET',
      `/me/credit-applications/${rejected.applicationId}`,
    );
    expect(theirs.body).toMatchObject({ status: 'rejected', approvedAmountRial: null });
    expect(JSON.stringify(theirs.body)).not.toMatch(SECRET);

    const { rows } = await h.owner.query<Row>(
      `SELECT id, payload, created_at FROM outbox_events
        WHERE event_type = 'credit.decided' AND aggregate_id = $1`,
      [rejected.applicationId],
    );
    expect(rows).toHaveLength(1);
    const sent: { mobile: string; text: string }[] = [];
    const notifier = new CreditNotifier(
      { register: () => undefined },
      h.app.get(CONFIG),
      h.app.get(LEAD_CASES),
      { sendText: (job) => Promise.resolve(void sent.push(job)) },
    );
    const row = rows[0] ?? {};
    await notifier.handle(
      {
        id: row['id'] as string,
        type: 'credit.decided',
        aggregateType: 'credit_application',
        aggregateId: rejected.applicationId,
        payload: row['payload'],
        occurredAt: (row['created_at'] as Date).toISOString(),
      },
      h.app.get<Database>(DATABASE),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.mobile).toBe(rejected.patient.mobile);
    expect(sent[0]?.text).toContain('تأیید نشد');
    expect(sent[0]?.text).not.toMatch(/رتبه|امتیاز|شغل|توقف|دکتر|کلینیک/);
  });

  it('a guarantor still sees only their own commitment once decided', async () => {
    const manager = await w.role('credit_manager');
    const { patient, applicationId } = await w.inReview();
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'borrower',
        raw: alef,
      },
    );
    const mobile = newMobile();
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
      mobile: `0${mobile}`,
    });
    const guarantor = await w.patient(mobile);
    await w.consent(guarantor, applicationId, 'guarantor');
    await w.documented(guarantor, applicationId, 'guarantor');
    const scoring = await w.staff(
      w.creditSpecialist,
      'GET',
      `/credit/applications/${applicationId}/scoring`,
    );
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'guarantor',
        guarantorId: (scoring.body['guarantors'] as Body[])[0]?.['id'],
        raw: {
          job: 'official',
          employmentStartedOn: { year: 1395, month: 1, day: 1 },
          averageBalanceRial: '30000000',
          installmentRial: '900000',
          debts: 'none_or_very_low',
          independence: 'fully_independent',
        },
      },
    );
    await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
    const proposed = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/decisions`,
      { outcome: 'approved', reason: 'رتبه الف' },
    );
    await w.staff(
      manager,
      'POST',
      `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
    );
    const mine = await w.as(guarantor, 'GET', '/me/guarantees');
    expect((mine.body as unknown as Body[]).map((g) => Object.keys(g).sort())).toEqual([
      ['commitmentRial', 'consentGiven', 'creditApplicationId', 'id', 'invitedAt', 'status'],
    ]);
    expect(JSON.stringify(mine.body)).not.toMatch(SECRET);
    expect((await w.as(guarantor, 'GET', `/me/credit-applications/${applicationId}`)).status).toBe(
      404,
    );
  });
});

describe('the consent text (task 3-8)', () => {
  it('is read by a patient-kind account before consenting, with its version', async () => {
    const someone = await w.patient();
    const read = await w.as(someone, 'GET', '/me/credit/consent-text');
    expect(read.status).toBe(200);
    // 0098 (owner 1405/07/27): the draft from the client's samples, labelled until counsel approves.
    expect(read.body['text']).toEqual(expect.stringContaining('پیش‌نویس — در انتظار تأیید حقوقی'));
    expect(read.body['versionId']).toEqual(expect.any(String));
    expect((await w.staff(w.creditSpecialist, 'GET', '/me/credit/consent-text')).status).toBe(403);
  });
});
