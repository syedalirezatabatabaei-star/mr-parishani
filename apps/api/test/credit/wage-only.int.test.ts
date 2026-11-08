import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../src/common/proforma/proforma-directory.port';
import { grantRole, startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from './funding-steps';
import { CREDIT_HARNESS, creditWorld, PLAN, type Body, type Row } from './world';

/**
 * ADR-050 (ج۳; owner 1405/07/30, answer 7; plans approved): a loan on the doctor's wage only.
 * The down payment stays 18% of the whole proforma (T); the loan is the wage lines (W) less it;
 * the materials (T − W) are paid to the doctor in cash, recorded on the case only, never in the
 * ledger; a down payment at or above W refuses the plan. Finance checks the split before the
 * decision; the materials are no shortfall; the purse is charged A + D = W, and a material line
 * is never authorized from it. Every plan financing everything is unchanged.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let steps: ReturnType<typeof fundingSteps>;
let manager: Staff;

/** The annex's 07-220012: 18% down payment on the whole, no plan fee, wage only. */
const WAGE = {
  ...PLAN,
  code: 'wage_12',
  title: 'طرح فقط دستمزد',
  downPayment: { basis: 'percent', bps: 1800 },
  planFee: { basis: 'percent', bps: 0, timing: 'spread' },
  financeableBasis: 'wage',
} as const;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  steps = fundingSteps(h, w, { manager, finance: await w.role('accounting') });
  const [a, b] = [await w.role('strategy_manager'), await w.role('strategy_manager')];
  const proposal = await w.staff(a, 'POST', '/config/proposals', {
    key: 'credit.plans',
    scope: { level: 'global' },
    value: { plans: [PLAN, WAGE] },
    reason: 'طرح فقط دستمزد، آزمون',
  });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  expect(
    (await w.staff(b, 'POST', `/config/proposals/${proposal.body['id'] as string}/approve`)).status,
  ).toBe(200);
  // The world's scaling becomes materials (the visit stays the doctor's wage).
  const network = await w.role('network_manager');
  const changed = await w.staff(network, 'PATCH', '/catalog/services/scaling', {
    costKind: 'material',
    reason: 'جرم‌گیری: هزینه مواد، آزمون',
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body).toMatchObject({ code: 'scaling', costKind: 'material' });
}, 180_000);

afterAll(async () => {
  await h.close();
});

const appRow = async (id: string) =>
  (
    await h.owner.query<Row>(
      `SELECT proforma_total_rial::text AS t, down_payment_rial::text AS d, loan_rial::text AS l,
              cash_top_up_rial::text AS c, wage_rial::text AS w, material_cash_rial::text AS m
         FROM credit_applications WHERE id = $1`,
      [id],
    )
  ).rows[0];

describe('ADR-050: a loan on the wage only', () => {
  it('copies the cost kind onto each line; another needs its reason; issuing records the split', async () => {
    const { proformaId } = await w.confirmedProforma();
    const { rows } = await h.owner.query<Row>(
      'SELECT service_code, cost_kind, cost_kind_reason FROM proforma_lines WHERE proforma_id = $1 ORDER BY line_no',
      [proformaId],
    );
    expect(rows).toEqual([
      { service_code: 'visit', cost_kind: 'wage', cost_kind_reason: null },
      { service_code: 'scaling', cost_kind: 'material', cost_kind_reason: null },
    ]);
    const audit = await h.owner.query<Row>(
      `SELECT after FROM audit_events WHERE action = 'proforma.issued' AND entity_id = $1`,
      [proformaId],
    );
    expect(audit.rows[0]?.['after']).toMatchObject({ materialLines: 1, materialRial: '6000000' });
    // The issuer's own split of a line needs its reason.
    const appointment = await h.owner.query<Row>(
      `SELECT r.appointment_id::text AS a FROM proformas p JOIN referrals r ON r.id = p.referral_id
        WHERE p.id = $1`,
      [proformaId],
    );
    // A new draft for the same appointment (a draft is never issued here).
    const draft = (lines: Body[]) =>
      w.staff(w.doctor, 'POST', '/proformas', {
        appointmentId: appointment.rows[0]?.['a'],
        lines,
      });
    expect(appointment.rows).toHaveLength(1);
    const refused = await draft([{ serviceCode: 'scaling', quantity: 1, costKind: 'wage' }]);
    expect(refused.body).toMatchObject({ error: 'cost_kind_reason_required' });
    const split = await draft([
      { serviceCode: 'scaling', quantity: 1, costKind: 'wage', costKindReason: 'دستمزد پزشک است' },
    ]);
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    expect((split.body['lines'] as Body[])[0]).toMatchObject({
      costKind: 'wage',
      costKindReason: 'دستمزد پزشک است',
    });
  });

  it('finances W less 18% of T; the materials go to the doctor in cash, recorded on the case', async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const options = await w.as(patient, 'GET', `/me/proformas/${proformaId}/plans`);
    const wage = (options.body['plans'] as Body[]).find((p) => p['code'] === WAGE.code);
    expect(options.body['unavailablePlans']).toEqual([]);
    // T = 12,000,000; W = 6,000,000 (the visit); D = 18% of T = 2,160,000; loan 3,840,000.
    expect((wage?.['options'] as Body[])[0]?.['quote']).toMatchObject({
      downPaymentRial: '2160000',
      loanRial: '3840000',
      materialCashRial: '6000000',
      cashTopUpRial: '6000000',
    });
    const made = await w.as(patient, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: WAGE.code,
      installmentCount: 12,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ loanRial: '3840000', materialCashRial: '6000000' });
    expect(await appRow(made.body['id'] as string)).toEqual({
      t: '12000000',
      d: '2160000',
      l: '3840000',
      c: '6000000',
      w: '6000000',
      m: '6000000',
    });
    // A plan financing everything is as before: no wage, no materials.
    const other = await w.confirmedProforma();
    const plain = await w.as(other.patient, 'POST', '/me/credit-applications', {
      proformaId: other.proformaId,
      planCode: PLAN.code,
      installmentCount: 12,
    });
    expect(await appRow(plain.body['id'] as string)).toMatchObject({
      l: '9600000',
      c: '0',
      w: null,
      m: '0',
    });
  });

  it('refuses the plan when the down payment reaches the wage lines', async () => {
    // T = 5,000,000 + 8 × 3,000,000 = 29,000,000; D = 5,220,000 ≥ W = 5,000,000.
    const { patient, proformaId } = await w.confirmedProforma(undefined, 8, '5000000');
    const options = await w.as(patient, 'GET', `/me/proformas/${proformaId}/plans`);
    expect((options.body['plans'] as Body[]).map((p) => p['code'])).not.toContain(WAGE.code);
    // ADR-050 amendment: named as unavailable, with no figure at all.
    expect(options.body['unavailablePlans']).toEqual([{ code: WAGE.code, title: WAGE.title }]);
    const refused = await w.as(patient, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: WAGE.code,
      installmentCount: 12,
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: 'down_payment_exceeds_wage' });
  });

  it('is never a group or a shortfall plan', async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const refused = await w.as(patient, 'POST', '/me/credit-application-groups', {
      proformaId,
      members: [
        { planCode: WAGE.code, installmentCount: 12, shareRial: '6000000' },
        {
          planCode: PLAN.code,
          installmentCount: 12,
          shareRial: '6000000',
          borrowerMobile: '9121234567',
        },
      ],
    });
    expect(refused.body).toMatchObject({ error: 'wage_plan_not_for_groups' });
  });

  it('waits for the split check; the materials are no shortfall; the purse is W; no material line from it', async () => {
    // T = 6,000,000 + 3 × 3,000,000 = 15,000,000; W = 6,000,000; M = 9,000,000 (W ≠ M).
    const { patient, applicationId } = await w.inReview(undefined, 3, undefined, WAGE.code);
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'borrower',
        raw: {
          job: 'official',
          employmentStartedOn: { year: 1398, month: 1, day: 1 },
          coverage: 'full',
          obligationsRial: '1000000',
          newInstallmentRial: '4000000',
        },
      },
    );
    const early = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/to-decision`,
    );
    expect(early.status).toBe(409);
    expect(early.body['missing']).toContain('cost_split_review');
    // Not for a holder without the permission; then once, with a note.
    const review = (who: Staff) =>
      w.staff(who, 'POST', `/credit/applications/${applicationId}/cost-split-review`, {
        note: 'تفکیک دستمزد و مواد با پیش‌فاکتور خوانده شد',
      });
    expect((await review(manager)).status).toBe(403);
    // ADR-050 amendment (owner 1405/08/01): the issuer of the split never checks it, even with
    // the permission.
    await grantRole(h, w.doctor.id, 'case_completion');
    expect((await review(w.doctor)).body).toMatchObject({ error: 'reviewer_is_issuer' });
    const done = await review(w.creditSpecialist);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({
      wageOnly: true,
      wageRial: '6000000',
      materialCashRial: '9000000',
    });
    expect((await review(w.completion)).body).toMatchObject({ error: 'already_reviewed' });
    await expect(h.owner.query('UPDATE credit_cost_split_reviews SET note = note')).rejects.toThrow(
      /append-only/,
    );

    await steps.decide(applicationId);
    const { rows } = await h.owner.query<Row>(
      `SELECT approved_cash_top_up_rial::text AS top_up, shortfall_kind FROM credit_applications
        WHERE id = $1`,
      [applicationId],
    );
    // The materials are the doctor's in cash by design: no shortfall at all.
    expect(rows[0]).toEqual({ top_up: '0', shortfall_kind: 'none' });

    await steps.complete(patient, applicationId);
    const purseId = await steps.fund(applicationId);
    const purse = await h.owner.query<Row>(
      `SELECT approved_amount_rial::text AS a, down_payment_rial::text AS d FROM credit_purses
        WHERE id = $1`,
      [purseId],
    );
    // A + D = W: D = 18% of 15,000,000 = 2,700,000; A = 6,000,000 − 2,700,000.
    expect(purse.rows[0]).toEqual({ a: '3300000', d: '2700000' });

    const lines = await h.app
      .get<ProformaDirectory>(PROFORMA_DIRECTORY)
      .lines(
        (
          await h.owner.query<Row>('SELECT proforma_id FROM credit_applications WHERE id = $1', [
            applicationId,
          ])
        ).rows[0]?.['proforma_id'] as string,
      );
    const material = lines.find((l) => l.costKind === 'material');
    const wage = lines.find((l) => l.costKind === 'wage');
    const view = await w.staff(w.doctor, 'GET', `/service/patients/${purseId}/lines`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect((view.body['lines'] as Body[]).map((l) => [l['id'], l['cashOnly']])).toEqual(
      expect.arrayContaining([
        [material?.id, true],
        [wage?.id, false],
      ]),
    );
    const refused = await w.staff(w.doctor, 'POST', '/service/authorizations', {
      purseId,
      proformaLineIds: [material?.id],
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: 'line_is_material' });
    const allowed = await w.staff(w.doctor, 'POST', '/service/authorizations', {
      purseId,
      proformaLineIds: [wage?.id],
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);

    // The materials never reach the ledger: no posting of 9,000,000 for this case.
    const ledger = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM journal_entries j JOIN ledger_entries e ON e.journal_entry_id = j.id
        WHERE j.credit_application_id = $1 AND e.amount_rial = 9000000`,
      [applicationId],
    );
    expect(ledger.rows[0]?.['n']).toBe(0);
  });

  it('keeps the materials consistent in the database, even for the owner', async () => {
    const { applicationId } = await w.inReview(undefined, undefined, undefined, WAGE.code);
    // The materials are T − W and within the cash to the doctor (CHECK, 0103).
    await expect(
      h.owner.query(
        'UPDATE credit_applications SET material_cash_rial = material_cash_rial + 1 WHERE id = $1',
        [applicationId],
      ),
    ).rejects.toThrow(/credit_applications_material_cash_check/);
    await expect(
      h.owner.query('UPDATE credit_applications SET wage_rial = wage_rial - 1 WHERE id = $1', [
        applicationId,
      ]),
    ).rejects.toThrow(/credit_applications_material_cash_check/);
    // A plan financing everything has no materials.
    const { applicationId: plain } = await w.inReview();
    await expect(
      h.owner.query('UPDATE credit_applications SET material_cash_rial = 1 WHERE id = $1', [plain]),
    ).rejects.toThrow(/credit_applications_material_cash_check/);
    // A line's cost kind is one of the two (CHECK, 0103).
    await expect(
      h.owner.query(`UPDATE services SET cost_kind = 'labour' WHERE code = 'scaling'`),
    ).rejects.toThrow(/services_cost_kind_check/);
  });

  it('refuses a split check of an application financing everything', async () => {
    const { applicationId } = await w.inReview();
    const refused = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/cost-split-review`,
      { note: 'بررسی بی‌مورد' },
    );
    expect(refused.body).toMatchObject({ error: 'not_wage_only' });
  });
});
