import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE, type Database } from '../../src/db/database.module';
import { BorrowerExposureService } from '../../src/modules/credit/borrower-exposure.service';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from './funding-steps';
import { CREDIT_HARNESS, creditWorld, type Patient, type Row } from './world';

/**
 * ADR-051 (ج۶; owner 1405/07/30, answer 8): the cap on a borrower's whole active balance, a
 * two-person key ("0" = off), checked under a lock on the borrower's row when a loan is approved
 * and when it is funded. The balance counts the other loans still owed (or their approved
 * amounts, by basis) and those approved but not funded; a refusal is a 409 recorded on its own.
 * Two of one borrower's decisions or fundings at once: exactly one passes when only one fits.
 *
 * The world's proforma is 12,000,000: a loan of 9,600,000 (20% down), spread fee 10%.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let steps: ReturnType<typeof fundingSteps>;
let manager: Staff;
let strategyA: Staff;
let strategyB: Staff;

const LOAN = 9_600_000n;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  steps = fundingSteps(h, w, { manager, finance: await w.role('accounting') });
  strategyA = await w.role('strategy_manager');
  strategyB = await w.role('strategy_manager');
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** The cap, set by two people as the panel does. */
async function setCap(capRial: string, basis = 'obligation', includeApprovedUnfunded = true) {
  const proposal = await w.staff(strategyA, 'POST', '/config/proposals', {
    key: 'credit.borrower_exposure_cap',
    scope: { level: 'global' },
    value: { capRial, basis, includeApprovedUnfunded },
    reason: 'سقف مانده وام‌گیرنده، آزمون',
  });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  expect(
    (await w.staff(strategyB, 'POST', `/config/proposals/${proposal.body['id'] as string}/approve`))
      .status,
  ).toBe(200);
}

/** Scored and proposed for approval by the specialist; the second check is the caller's. */
async function proposed(patient?: Patient) {
  // The same borrower asks a consent code again: past the resend cooldown, as a later day would.
  if (patient) await h.redis.del(`identity:challenge-cooldown:credit_consent:${patient.mobile}`);
  const { patient: who, applicationId } = await w.inReview(patient);
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw: {
      job: 'official',
      employmentStartedOn: { year: 1398, month: 1, day: 1 },
      coverage: 'full',
      obligationsRial: '1000000',
      newInstallmentRial: '4000000',
    },
  });
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
  const made = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    { outcome: 'approved', reason: 'رتبه الف' },
  );
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return { patient: who, applicationId, decisionId: made.body['id'] as string };
}

const confirm = (p: { applicationId: string; decisionId: string }) =>
  w.staff(
    manager,
    'POST',
    `/credit/applications/${p.applicationId}/decisions/${p.decisionId}/confirm`,
  );

const statusOf = async (id: string) =>
  (await h.owner.query<Row>('SELECT status FROM credit_applications WHERE id = $1', [id]))
    .rows[0]?.['status'];

const checksOf = async (id: string) =>
  (
    await h.owner.query<Row>(
      `SELECT step, exposure_rial::text AS exposure, amount_rial::text AS amount,
              cap_rial::text AS cap, basis, allowed
         FROM credit_exposure_checks WHERE credit_application_id = $1 ORDER BY created_at`,
      [id],
    )
  ).rows;

describe('ADR-051: the cap on a borrower’s active balance', () => {
  it('is off at "0": no check, nothing recorded', async () => {
    const one = await proposed();
    expect((await confirm(one)).status).toBe(201);
    expect(await checksOf(one.applicationId)).toEqual([]);
  });

  it('counts the approved and unfunded; one rial past the cap refuses the decision, recorded apart', async () => {
    // Two loans fit exactly: 2 × 9,600,000 = 19,200,000.
    await setCap('19200000');
    const first = await proposed();
    expect((await confirm(first)).status).toBe(201);
    const second = await proposed(first.patient);
    expect((await confirm(second)).status).toBe(201);
    expect(await checksOf(second.applicationId)).toEqual([
      {
        step: 'decision',
        exposure: '9600000',
        amount: '9600000',
        cap: '19200000',
        basis: 'obligation',
        allowed: true,
      },
    ]);
    const third = await proposed(first.patient);
    const refused = await confirm(third);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'borrower_exposure_cap_exceeded',
      exposureRial: '19200000',
      amountRial: '9600000',
      capRial: '19200000',
    });
    // Nothing of the decision stayed; the refusal is recorded on its own.
    expect(await statusOf(third.applicationId)).toBe('manual_review');
    expect(await checksOf(third.applicationId)).toEqual([
      {
        step: 'decision',
        exposure: '19200000',
        amount: '9600000',
        cap: '19200000',
        basis: 'obligation',
        allowed: false,
      },
    ]);
    // Another borrower is not this one's balance.
    const stranger = await proposed();
    expect((await confirm(stranger)).status).toBe(201);
    // Without the approved and unfunded, the third fits.
    await setCap('19200000', 'obligation', false);
    expect((await confirm(third)).status).toBe(201);
  });

  it('checks again at funding: a lower cap since the approval refuses it, recorded apart', async () => {
    await setCap('0');
    const a = await proposed();
    expect((await confirm(a)).status).toBe(201);
    const b = await proposed(a.patient);
    expect((await confirm(b)).status).toBe(201);
    await steps.complete(b.patient, b.applicationId);
    await setCap('15000000');
    const asked = await w.staff(w.completion, 'POST', '/funding/requests', {
      creditApplicationId: b.applicationId,
    });
    const finance = await w.role('accounting');
    const refused = await w.staff(
      finance,
      'POST',
      `/funding/requests/${asked.body['id'] as string}/approve`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'borrower_exposure_cap_exceeded' });
    const purse = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM credit_purses WHERE credit_application_id = $1',
      [b.applicationId],
    );
    expect(purse.rows[0]?.['n']).toBe(0);
    expect(await checksOf(b.applicationId)).toContainEqual(
      expect.objectContaining({ step: 'funding', exposure: '9600000', allowed: false }),
    );
    // Within the cap again: funded, and the pass recorded in the funding's transaction.
    await setCap('19200000');
    const done = await w.staff(
      finance,
      'POST',
      `/funding/requests/${asked.body['id'] as string}/approve`,
    );
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(await checksOf(b.applicationId)).toContainEqual(
      expect.objectContaining({ step: 'funding', exposure: '9600000', allowed: true }),
    );
  });

  it('counts a funded loan by what is still owed, or by its approved amount (basis)', async () => {
    await setCap('0');
    const funded = await proposed();
    expect((await confirm(funded)).status).toBe(201);
    await steps.complete(funded.patient, funded.applicationId);
    await steps.fund(funded.applicationId);
    const other = await proposed(funded.patient);
    const service = h.app.get(BorrowerExposureService);
    const borrower = (
      await h.owner.query<Row>('SELECT borrower_person_id FROM credit_applications WHERE id = $1', [
        funded.applicationId,
      ])
    ).rows[0]?.['borrower_person_id'] as string;
    const db = h.app.get<Database>(DATABASE);
    const [obligation, loan] = await db.transaction(async (tx) => [
      await service.exposureOf(tx, borrower, other.applicationId, 'obligation', true),
      await service.exposureOf(tx, borrower, other.applicationId, 'loan', true),
    ]);
    // Owed: the loan plus its spread fee (10%), nothing paid yet; the loan basis: 9,600,000.
    expect(obligation).toBe(LOAN + LOAN / 10n);
    expect(loan).toBe(LOAN);
  });

  it('never counts an approved loan whose cancellation was approved', async () => {
    await setCap('0');
    const cancelled = await proposed();
    expect((await confirm(cancelled)).status).toBe(201);
    const asked = await w.staff(w.completion, 'POST', '/credit/cancellations', {
      creditApplicationId: cancelled.applicationId,
      reason: 'بیمار از درمان انصراف داد',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const finance = await w.role('accounting');
    const done = await w.staff(
      finance,
      'POST',
      `/credit/cancellations/${asked.body['id'] as string}/approve`,
      { reason: 'انصراف بررسی شد' },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    // One loan's room only: the cancelled one does not take it.
    await setCap('9600000');
    const next = await proposed(cancelled.patient);
    expect((await confirm(next)).status).toBe(201);
  });

  it('keeps its checks append-only, even for the owner', async () => {
    await expect(
      h.owner.query('UPDATE credit_exposure_checks SET allowed = allowed'),
    ).rejects.toThrow(/append-only/);
    await expect(h.owner.query('DELETE FROM credit_exposure_checks')).rejects.toThrow(
      /append-only/,
    );
  });
});
