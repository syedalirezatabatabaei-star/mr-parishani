import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newMobile, startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Patient, type Row } from './world';

/**
 * Task 3-7 (doc 10 §7): a small shortfall is paid in cash outside the ledger; a large one
 * gets a new case and loan in a group; over the cap, two borrowers each finance a share of
 * one proforma. Two applications of a group are scored and decided independently, and the
 * rejection of one leaves the other unchanged (the acceptance test of doc 11 3-7).
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let manager: Awaited<ReturnType<typeof loggedInAccount>>;

const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};
const dal = { ...alef, job: 'none_stop' };

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** Submitted by the patient; consent and documents by the borrower; sent to review. */
async function toReview(patient: Patient, borrower: Patient, applicationId: string) {
  expect(
    (await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/submit`)).status,
  ).toBe(201);
  await w.consent(borrower, applicationId, 'borrower');
  await w.documented(borrower, applicationId, 'borrower');
  expect(
    (await w.staff(w.completion, 'POST', `/credit/applications/${applicationId}/ready-for-review`))
      .status,
  ).toBe(201);
}

/** Scored with `raw`, sent to the decision, proposed by the specialist, checked by the manager. */
async function decide(applicationId: string, raw: Body, proposal: Body) {
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw,
  });
  expect(
    (await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`))
      .status,
  ).toBe(201);
  const proposed = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    proposal,
  );
  expect(proposed.status).toBe(201);
  const confirmed = await w.staff(
    manager,
    'POST',
    `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
  );
  expect(confirmed.status).toBe(201);
}

describe('over the cap: two borrowers, one proforma', () => {
  it('each finances a share, and is scored and decided on its own', async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const otherMobile = newMobile();
    const member = (shareRial: string, borrowerMobile?: string) => ({
      planCode: 'dental_12',
      installmentCount: 12,
      shareRial,
      ...(borrowerMobile === undefined ? {} : { borrowerMobile }),
    });
    const path = '/me/credit-application-groups';
    expect(
      (
        await w.as(patient, 'POST', path, {
          proformaId,
          members: [member('6000000'), member('5000000', `0${otherMobile}`)],
        })
      ).body['error'],
    ).toBe('shares_must_add_up');
    expect(
      (
        await w.as(patient, 'POST', path, {
          proformaId,
          members: [member('6000000'), member('6000000')],
        })
      ).body['error'],
    ).toBe('same_borrower');
    const made = await w.as(patient, 'POST', path, {
      proformaId,
      members: [member('7000000'), member('5000000', `0${otherMobile}`)],
    });
    expect(made.status).toBe(201);
    const [mine, theirs] = made.body as unknown as Body[];
    const groupId = mine?.['caseGroupId'] as string;
    expect(theirs?.['caseGroupId']).toBe(groupId);
    // Each its own down payment and fees, on its own share (owner, 1405/07/10).
    expect(mine).toMatchObject({
      proformaTotalRial: '7000000',
      downPaymentRial: '1400000',
      loanRial: '5600000',
      borrowerIsPatient: true,
    });
    expect(theirs).toMatchObject({
      proformaTotalRial: '5000000',
      downPaymentRial: '1000000',
      loanRial: '4000000',
      borrowerIsPatient: false,
      originationFeeRial: '500000',
    });
    // Alone, still one open application per proforma.
    expect(
      (
        await w.as(patient, 'POST', '/me/credit-applications', {
          proformaId,
          planCode: 'dental_12',
          installmentCount: 12,
        })
      ).body['error'],
    ).toBe('application_exists');

    const other = await w.patient(otherMobile);
    const mineId = mine?.['id'] as string;
    const theirsId = theirs?.['id'] as string;
    await toReview(patient, patient, mineId);
    await toReview(patient, other, theirsId);
    await decide(theirsId, dal, { outcome: 'rejected', reasonCode: 'grade', reason: 'رتبه د' });
    await decide(mineId, alef, { outcome: 'approved', reason: 'رتبه الف' });

    const report = await w.staff(w.creditSpecialist, 'GET', `/credit/groups/${groupId}`);
    expect(report.status).toBe(200);
    expect(report.body['members']).toEqual([
      expect.objectContaining({ id: mineId, status: 'approved', shareRial: '7000000' }),
      expect.objectContaining({ id: theirsId, status: 'rejected', shareRial: '5000000' }),
    ]);
    // The rejection did not change the other, nor close the case it still finances.
    const { rows } = await h.owner.query<Row>(
      `SELECT c.status FROM cases c JOIN credit_applications a ON a.case_id = c.id WHERE a.id = $1`,
      [mineId],
    );
    expect(rows[0]?.['status']).not.toBe('cancelled');
    const list = await w.staff(w.creditSpecialist, 'GET', '/credit/groups');
    expect((list.body as unknown as Body[]).some((g) => g['caseGroupId'] === groupId)).toBe(true);
    expect((await w.staff(w.doctor, 'GET', `/credit/groups/${groupId}`)).status).toBe(403);
    // Joining a group is for good.
    await expect(
      h.owner.query(`UPDATE credit_applications SET case_group_id = NULL WHERE id = $1`, [mineId]),
    ).rejects.toThrow(/is in a group/);
  });
});

describe('shortfalls', () => {
  it('a small one is paid in cash and recorded; it opens no new loan', async () => {
    const { patient, applicationId } = await w.inReview();
    await decide(applicationId, alef, {
      outcome: 'approved',
      approvedAmountRial: '9000000',
      reason: 'کاهش اندک',
    });
    const mine = await w.as(patient, 'GET', `/me/credit-applications/${applicationId}`);
    expect(mine.body).toMatchObject({
      approvedAmountRial: '9000000',
      approvedCashTopUpRial: '600000',
      shortfallKind: 'small',
      caseGroupId: null,
    });
    const tried = await w.as(
      patient,
      'POST',
      `/me/credit-applications/${applicationId}/shortfall-application`,
      { planCode: 'dental_12', installmentCount: 6 },
    );
    expect(tried.body['error']).toBe('no_large_shortfall');
  });

  it('a large one gets a new case and loan in the group, once', async () => {
    const { patient, applicationId } = await w.inReview();
    await decide(applicationId, alef, {
      outcome: 'approved',
      approvedAmountRial: '5000000',
      reason: 'کاهش مبلغ',
    });
    const approved = await w.as(patient, 'GET', `/me/credit-applications/${applicationId}`);
    expect(approved.body).toMatchObject({
      approvedCashTopUpRial: '4600000',
      shortfallKind: 'large',
    });
    const made = await w.as(
      patient,
      'POST',
      `/me/credit-applications/${applicationId}/shortfall-application`,
      { planCode: 'dental_12', installmentCount: 6 },
    );
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      status: 'draft',
      proformaTotalRial: '4600000',
      downPaymentRial: '920000',
      loanRial: '3680000',
    });
    expect(made.body['caseId']).not.toBe(approved.body['caseId']);
    const groupId = made.body['caseGroupId'] as string;
    const first = await w.as(patient, 'GET', `/me/credit-applications/${applicationId}`);
    expect(first.body['caseGroupId']).toBe(groupId);
    const { rows } = await h.owner.query<Row>(
      'SELECT person_id, previous_case_id, status FROM cases WHERE id = $1',
      [made.body['caseId']],
    );
    expect(rows[0]).toMatchObject({ previous_case_id: approved.body['caseId'], status: 'new' });
    const again = await w.as(
      patient,
      'POST',
      `/me/credit-applications/${applicationId}/shortfall-application`,
      { planCode: 'dental_12', installmentCount: 6 },
    );
    expect(again.body['error']).toBe('application_exists');
    // The shortfall recorded at the decision never changes.
    await expect(
      h.owner.query(`UPDATE credit_applications SET shortfall_kind = 'small' WHERE id = $1`, [
        applicationId,
      ]),
    ).rejects.toThrow(/shortfall .* was recorded/);
  });
});
