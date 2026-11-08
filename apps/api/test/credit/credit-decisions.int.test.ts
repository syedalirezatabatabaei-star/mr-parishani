import { toJalali } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  grantRole,
  loggedInAccount,
  newMobile,
  startHarness,
  type Harness,
} from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from './world';

/**
 * Task 3-6 (doc 10 §6): who decides is the engine's and locked on the application; a
 * reduced amount is levelled again (§10 test 7); a rejecting grade is never approved, not
 * even by a direct call (test 8); the second check is another person, and the committee
 * needs members of two units (test 9); out of the matrix needs a second approver and the
 * committee.
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
let manager: Staff;
let manager2: Staff;
let strategy: Staff;
let both: Staff;
let committee: { strategyA: Staff; strategyB: Staff; collection: Staff; finance: Staff };

const today = toJalali(new Date());
/** 100: «الف». */
const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};
/** 25 + 5 + 0 + 25 = 55: «ج», a committee case. */
const jim = {
  ...alef,
  employmentStartedOn: { year: today.year, month: 1, day: 1 },
  coverage: 'under_80',
};
/** A stop: «د», rejected with no individual override. */
const dal = { ...alef, job: 'none_stop' };
const guarantorRaw = {
  job: 'official',
  employmentStartedOn: { year: 1395, month: 1, day: 1 },
  averageBalanceRial: '30000000',
  installmentRial: '900000',
  debts: 'none_or_very_low',
  independence: 'fully_independent',
};

async function member(...roles: string[]) {
  const who = await loggedInAccount(h, 'staff');
  for (const role of roles) await grantRole(h, who.id, role);
  return who;
}

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  manager2 = await w.role('credit_manager');
  strategy = await w.role('strategy_manager');
  both = await member('credit_specialist', 'credit_manager');
  committee = {
    strategyA: await member('strategy_manager', 'credit_committee'),
    strategyB: await member('strategy_manager', 'credit_committee'),
    collection: await member('collection', 'credit_committee'),
    finance: await member('accounting', 'credit_committee'),
  };
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** An application in review, its borrower scored with `raw`, sent to the decision. */
async function atDecision(raw: Body, scalings?: number) {
  const { patient, applicationId } = await w.inReview(undefined, scalings);
  const sheet = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/score-sheets`,
    { subject: 'borrower', raw },
  );
  expect(sheet.status).toBe(201);
  const sent = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/to-decision`,
  );
  expect(sent.status).toBe(201);
  expect(sent.body['status']).toBe('manual_review');
  return { patient, applicationId, page: sent.body };
}

const decisions = (applicationId: string) => `/credit/applications/${applicationId}/decisions`;
const minutes = (...attendees: Staff[]) => ({
  minutesNumber: `CRC-${String(Math.floor(Math.random() * 1e6))}`,
  meetingAt: new Date().toISOString(),
  attendeeAccountIds: attendees.map((a) => a.id),
});

async function caseOf(applicationId: string): Promise<Row> {
  const { rows } = await h.owner.query<Row>(
    `SELECT c.status, c.abandonment_reason_code FROM cases c
       JOIN credit_applications a ON a.case_id = c.id WHERE a.id = $1`,
    [applicationId],
  );
  return rows[0] ?? {};
}

describe('to the decision', () => {
  it('locks the engine’s authority, after every guarantor is consented, scored and documented', async () => {
    const { patient, applicationId } = await w.inReview(undefined, 20);
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
    const early = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/to-decision`,
    );
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('not_complete');
    const missing = early.body['missing'] as string[];
    expect(missing.some((m) => m.startsWith('consent:guarantor:'))).toBe(true);
    expect(missing.some((m) => m.startsWith('score:guarantor:'))).toBe(true);
    expect(missing.some((m) => /^document:guarantor:.+:national_card$/.test(m))).toBe(true);

    const guarantor = await w.patient(mobile);
    await w.consent(guarantor, applicationId, 'guarantor');
    await w.documented(guarantor, applicationId, 'guarantor');
    const scoring = await w.staff(
      w.creditSpecialist,
      'GET',
      `/credit/applications/${applicationId}/scoring`,
    );
    const guarantorId = (scoring.body['guarantors'] as Body[])[0]?.['id'];
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'guarantor',
        guarantorId,
        raw: guarantorRaw,
      },
    );
    // Others may not send it on; the specialist does, and the engine's authority is locked.
    expect(
      (await w.staff(w.completion, 'POST', `/credit/applications/${applicationId}/to-decision`))
        .status,
    ).toBe(403);
    const sent = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/to-decision`,
    );
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ status: 'manual_review', authority: 'credit_manager' });
    expect(sent.body['creditScore']).toMatchObject({
      borrowerGrade: 'alef',
      amountLevel: 'medium',
      sufficiency: 'sufficient',
    });

    // The credit manager decides alone where the engine names the credit manager.
    const decided = await w.staff(manager, 'POST', decisions(applicationId), {
      outcome: 'approved',
      reason: 'ضمانت ممتاز و رتبه الف',
    });
    expect(decided.status).toBe(201);
    expect(decided.body).toMatchObject({
      status: 'decided',
      authority: 'credit_manager',
      approvedAmountRial: '52800000',
    });
    const page = await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`);
    expect(page.body).toMatchObject({
      status: 'approved',
      decision: 'approved',
      approvedAmountRial: '52800000',
    });
    // Approved: plan, count and preview are locked; the decision is never changed again.
    const quote = (decided.body['quote'] ?? {}) as Body;
    expect((quote['installments'] as Body[]).length).toBe(12);
    await expect(
      h.owner.query(`UPDATE credit_applications SET approved_amount_rial = 1000 WHERE id = $1`, [
        applicationId,
      ]),
    ).rejects.toThrow(/was decided/);
  });

  it('a decision is only proposed for an application at its decision', async () => {
    const { applicationId } = await w.inReview();
    const early = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'rejected',
      reasonCode: 'other',
      reason: 'آزمون',
    });
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('wrong_status');
  });
});

describe('a reduced amount is levelled again (doc 10 §10 test 7)', () => {
  it('medium without a guarantor needs the matrix; reduced to «low», the specialist and a second check decide', async () => {
    const { applicationId, page } = await atDecision(alef, 20);
    expect(page).toMatchObject({ authority: 'credit_manager' });
    expect(page['creditScore']).toMatchObject({
      amountLevel: 'medium',
      sufficiency: 'insufficient',
    });

    const whole = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'approved',
      reason: 'کل مبلغ',
    });
    expect(whole.status).toBe(409);
    expect(whole.body['error']).toBe('out_of_matrix_required');
    expect(
      (
        await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
          outcome: 'approved',
          approvedAmountRial: '60000000',
          reason: 'بیش از وام',
        })
      ).status,
    ).toBe(400);

    const reduced = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'conditional',
      approvedAmountRial: '40000000',
      conditions: ['ارائه چک ضمانت'],
      reason: 'کاهش مبلغ به سطح کم',
    });
    expect(reduced.status).toBe(201);
    expect(reduced.body).toMatchObject({
      status: 'proposed',
      authority: 'expert_second_check',
      approvedAmountRial: '40000000',
      creditScore: { amountLevel: 'low' },
    });
    const quote = reduced.body['quote'] as Body;
    expect(quote['loanRial']).toBe('40000000');
    expect(quote['cashTopUpRial']).toBe('12800000');
    const now = await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`);
    expect(now.body).toMatchObject({ authority: 'expert_second_check' });
    expect(now.body['creditScore']).toMatchObject({
      amountLevel: 'low',
      sufficiency: 'not_required',
    });

    const checked = await w.staff(
      manager,
      'POST',
      `${decisions(applicationId)}/${reduced.body['id'] as string}/confirm`,
    );
    expect(checked.status).toBe(201);
    expect(checked.body).toMatchObject({ status: 'decided', checkedBy: manager.id });
    const final = await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`);
    expect(final.body).toMatchObject({
      status: 'conditional',
      decision: 'conditional',
      approvedAmountRial: '40000000',
      conditions: ['ارائه چک ضمانت'],
    });
  });
});

describe('a rejecting grade is never approved (doc 10 §10 test 8)', () => {
  it('not by the specialist, the manager or a direct call; only rejected, which closes the case', async () => {
    const { applicationId, page } = await atDecision(dal);
    expect(page).toMatchObject({ authority: 'reject_no_override' });
    for (const who of [w.creditSpecialist, manager]) {
      for (const outcome of ['approved', 'conditional'] as const) {
        const tried = await w.staff(who, 'POST', decisions(applicationId), {
          outcome,
          reason: 'تلاش برای تأیید',
          ...(outcome === 'conditional' ? { conditions: ['شرط'] } : {}),
        });
        expect(tried.status).toBe(409);
        expect(tried.body['error']).toBe('approval_not_allowed');
      }
    }
    // Out of the matrix is not the specialist's (doc 04 §3).
    const exception = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'approved',
      outOfMatrix: true,
      reason: 'استثنا',
      committee: minutes(committee.strategyA, committee.collection),
    });
    expect(exception.status).toBe(403);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM credit_decisions WHERE credit_application_id = $1`,
      [applicationId],
    );
    expect(rows[0]?.['n']).toBe(0);

    // No decision without a reason; a reason code from the list.
    expect(
      (
        await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
          outcome: 'rejected',
          reasonCode: 'grade',
          reason: '',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
          outcome: 'rejected',
          reasonCode: 'no_such_reason',
          reason: 'رتبه د',
        })
      ).body['error'],
    ).toBe('unknown_rejection_reason');
    const rejected = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'rejected',
      reasonCode: 'grade',
      reason: 'شرط توقف: شغل بدون مدرک',
    });
    expect(rejected.status).toBe(201);
    expect(rejected.body).toMatchObject({ status: 'proposed', authority: 'expert_second_check' });
    const confirmed = await w.staff(
      manager,
      'POST',
      `${decisions(applicationId)}/${rejected.body['id'] as string}/confirm`,
    );
    expect(confirmed.status).toBe(201);
    expect(
      (await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`)).body,
    ).toMatchObject({ status: 'rejected', decision: 'rejected', approvedAmountRial: null });
    expect(await caseOf(applicationId)).toMatchObject({
      status: 'cancelled',
      abandonment_reason_code: 'credit_rejected',
    });
  });
});

describe('two people, and two units (doc 10 §10 test 9)', () => {
  it('the second check of one’s own proposal is refused, even holding both roles', async () => {
    const { applicationId } = await atDecision(alef);
    const proposed = await w.staff(both, 'POST', decisions(applicationId), {
      outcome: 'approved',
      reason: 'رتبه الف، سطح کم',
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ status: 'proposed', authority: 'expert_second_check' });
    const id = proposed.body['id'] as string;
    const self = await w.staff(both, 'POST', `${decisions(applicationId)}/${id}/confirm`);
    expect(self.status).toBe(409);
    expect(self.body['error']).toBe('same_person');
    // The database says the same.
    await expect(
      h.owner.query(
        `UPDATE credit_decisions SET checked_by = proposed_by, checked_at = now() WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/credit_decisions_shape_check/);
    // A specialist alone may not confirm.
    expect(
      (await w.staff(w.creditSpecialist, 'POST', `${decisions(applicationId)}/${id}/confirm`))
        .status,
    ).toBe(403);
    // One open proposal at a time.
    expect(
      (
        await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
          outcome: 'rejected',
          reasonCode: 'other',
          reason: 'دومی',
        })
      ).body['error'],
    ).toBe('decision_pending');
    const other = await w.staff(manager2, 'POST', `${decisions(applicationId)}/${id}/confirm`);
    expect(other.status).toBe(201);
    expect(other.body).toMatchObject({ status: 'decided', checkedBy: manager2.id });
    // Decided once: no more confirmations.
    expect(
      (await w.staff(manager, 'POST', `${decisions(applicationId)}/${id}/confirm`)).body['error'],
    ).toBe('decision_closed');
  });

  it('the committee decides only with approving members of two units, each a different person', async () => {
    const { applicationId, page } = await atDecision(jim);
    expect(page).toMatchObject({ authority: 'committee' });
    const queue = await w.staff(
      manager,
      'GET',
      `/credit/applications/${applicationId}/assignments`,
    );
    expect((queue.body as unknown as Body[]).some((a) => a['queueCode'] === 'committee')).toBe(
      true,
    );
    expect(
      (
        await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
          outcome: 'rejected',
          reasonCode: 'grade',
          reason: 'بدون صورت‌جلسه',
        })
      ).body['error'],
    ).toBe('committee_minutes_required');
    const { strategyA, strategyB, collection, finance } = committee;
    const proposed = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'rejected',
      reasonCode: 'insufficient_guarantee',
      reason: 'رتبه ج بدون ضامن ممتاز',
      committee: minutes(strategyA, strategyB, collection),
    });
    expect(proposed.status).toBe(201);
    const id = proposed.body['id'] as string;
    const vote = (who: Staff, unitCode: string, v = 'approve') =>
      w.staff(who, 'POST', `${decisions(applicationId)}/${id}/votes`, { unitCode, vote: v });

    // The committee decides; nobody confirms it alone.
    expect(
      (await w.staff(manager, 'POST', `${decisions(applicationId)}/${id}/confirm`)).body['error'],
    ).toBe('committee_decides');
    // A unit one is not a member of; someone not at the meeting.
    expect((await vote(strategyA, 'finance')).body['error']).toBe('not_a_unit_member');
    expect((await vote(finance, 'finance')).body['error']).toBe('not_an_attendee');
    expect((await vote(manager, 'strategy')).status).toBe(403);

    expect((await vote(strategyA, 'strategy')).body).toMatchObject({ status: 'proposed' });
    expect((await vote(strategyA, 'strategy')).body['error']).toBe('already_voted');
    // Two people of one unit are still one unit.
    expect((await vote(strategyB, 'strategy')).body).toMatchObject({ status: 'proposed' });
    expect(
      (await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`)).body,
    ).toMatchObject({ status: 'manual_review', decision: null });
    const second = await vote(collection, 'collection');
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ status: 'decided' });
    expect(((second.body['committee'] as Body)['votes'] as Body[]).length).toBe(3);
    expect(
      (await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`)).body,
    ).toMatchObject({ status: 'rejected', decision: 'rejected' });
    expect(await caseOf(applicationId)).toMatchObject({
      abandonment_reason_code: 'credit_rejected',
    });
  });

  it('the proposer never votes, for or against (owner 1405/08/01)', async () => {
    const { applicationId } = await atDecision(jim);
    // A specialist who is also a strategy member of the committee, and at the meeting.
    const proposer = await member('credit_specialist', 'strategy_manager', 'credit_committee');
    const { collection, finance } = committee;
    const proposed = await w.staff(proposer, 'POST', decisions(applicationId), {
      outcome: 'rejected',
      reasonCode: 'insufficient_guarantee',
      reason: 'رتبه ج بدون ضامن ممتاز',
      committee: minutes(proposer, collection, finance),
    });
    expect(proposed.status).toBe(201);
    const id = proposed.body['id'] as string;
    const vote = (who: Staff, unitCode: string, v = 'approve') =>
      w.staff(who, 'POST', `${decisions(applicationId)}/${id}/votes`, { unitCode, vote: v });
    const votes = async () =>
      Number(
        (
          await h.owner.query<Row>(
            'SELECT count(*)::text AS n FROM credit_committee_votes WHERE credit_decision_id = $1',
            [id],
          )
        ).rows[0]?.['n'],
      );

    // An objection would refuse the proposal alone: it is refused, and nothing is recorded.
    const objected = await vote(proposer, 'strategy', 'object');
    expect(objected.status).toBe(409);
    expect(objected.body['error']).toBe('proposer_cannot_vote');
    const approved = await vote(proposer, 'strategy');
    expect(approved.status).toBe(409);
    expect(approved.body['error']).toBe('proposer_cannot_vote');
    expect(await votes()).toBe(0);

    // Two other units decide it as before.
    expect((await vote(collection, 'collection')).body).toMatchObject({ status: 'proposed' });
    expect((await vote(finance, 'finance')).body).toMatchObject({ status: 'decided' });
    expect(await votes()).toBe(2);
  });

  it('one objection refuses a committee proposal', async () => {
    const { applicationId } = await atDecision(jim);
    const proposed = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'rejected',
      reasonCode: 'grade',
      reason: 'رتبه ج',
      committee: minutes(committee.strategyA, committee.finance),
    });
    const id = proposed.body['id'] as string;
    const objected = await w.staff(
      committee.finance,
      'POST',
      `${decisions(applicationId)}/${id}/votes`,
      {
        unitCode: 'finance',
        vote: 'object',
        note: 'نیاز به بررسی وثیقه',
      },
    );
    expect(objected.body).toMatchObject({ status: 'refused' });
    expect(
      (await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`)).body,
    ).toMatchObject({ status: 'manual_review' });
  });
});

describe('out of the matrix (doc 03 §6, doc 04 §5)', () => {
  it('needs a second approver and the committee, and is labelled in the history', async () => {
    const { applicationId } = await atDecision(jim);
    const { strategyA, collection } = committee;
    // In the normal path «ج» without a guarantor is insufficient.
    const normal = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'approved',
      reason: 'تأیید',
      committee: minutes(strategyA, collection),
    });
    expect(normal.body['error']).toBe('out_of_matrix_required');
    const proposed = await w.staff(strategy, 'POST', decisions(applicationId), {
      outcome: 'approved',
      outOfMatrix: true,
      reason: 'سابقه پرداخت عالی در وام قبلی؛ وثیقه ملکی',
      committee: minutes(strategyA, collection),
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ authority: 'committee', outOfMatrix: true });
    const id = proposed.body['id'] as string;
    await w.staff(strategyA, 'POST', `${decisions(applicationId)}/${id}/votes`, {
      unitCode: 'strategy',
      vote: 'approve',
    });
    const voted = await w.staff(collection, 'POST', `${decisions(applicationId)}/${id}/votes`, {
      unitCode: 'collection',
      vote: 'approve',
    });
    // The committee approved; the second approver is still missing.
    expect(voted.body).toMatchObject({ status: 'proposed' });
    expect(
      (await w.staff(strategy, 'POST', `${decisions(applicationId)}/${id}/confirm`)).body['error'],
    ).toBe('same_person');
    const checked = await w.staff(manager, 'POST', `${decisions(applicationId)}/${id}/confirm`);
    expect(checked.body).toMatchObject({ status: 'decided', checkedBy: manager.id });
    expect(
      (await w.staff(manager, 'GET', `/credit/applications/${applicationId}/decision`)).body,
    ).toMatchObject({ status: 'approved' });
    const { rows } = await h.owner.query<Row>(
      `SELECT after FROM audit_events WHERE entity_id = $1 AND action = 'credit.decided'`,
      [applicationId],
    );
    expect(rows[0]?.['after']).toMatchObject({ label: 'out_of_matrix', outcome: 'approved' });
  });
});

describe('needs more guarantors', () => {
  it('returns the application to case completion with the label and what is missing', async () => {
    const { applicationId, patient } = await atDecision(alef, 20);
    const back = await w.staff(w.creditSpecialist, 'POST', decisions(applicationId), {
      outcome: 'needs_more_guarantors',
      missing: ['یک ضامن حداقل قابل قبول'],
      reason: 'سطح متوسط بدون ضامن',
    });
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ status: 'decided', missing: ['یک ضامن حداقل قابل قبول'] });
    const mine = await w.as(patient, 'GET', `/me/credit-applications/${applicationId}`);
    expect(mine.body).toMatchObject({ status: 'incomplete', needsMoreGuarantors: true });
  });
});
