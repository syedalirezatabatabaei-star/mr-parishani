import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * This file: the races only, in a world of its own (one day of 24 slots: 10 rounds of two
 * proformas, then the decision and funding pair). The world's proforma is 12,000,000: a loan of
 * 9,600,000 (20% down), spread fee 10%.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let steps: ReturnType<typeof fundingSteps>;
let manager: Staff;
let strategyA: Staff;
let strategyB: Staff;

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

describe('ADR-051: two of one borrower’s decisions or fundings at once', () => {
  it('two decisions of one borrower at once: exactly one passes when only one fits (7 times)', async () => {
    await setCap('15000000');
    for (let i = 0; i < 7; i++) {
      const a = await proposed();
      const b = await proposed(a.patient);
      const results = await Promise.all([confirm(a), confirm(b)]);
      const codes = results.map((r) => r.status).sort();
      expect(codes, `round ${String(i)}: ${JSON.stringify(results.map((r) => r.body))}`).toEqual([
        201, 409,
      ]);
      const approved = (
        await Promise.all([statusOf(a.applicationId), statusOf(b.applicationId)])
      ).filter((s) => s === 'approved');
      expect(approved).toHaveLength(1);
    }
  }, 900_000);

  it('two fundings of one borrower at once: exactly one passes when only one fits (5 times)', async () => {
    const finance = await w.role('accounting');
    for (let i = 0; i < 5; i++) {
      // Both approved with the cap off, then completed and asked for.
      await setCap('0');
      const a = await proposed();
      expect((await confirm(a)).status).toBe(201);
      const b = await proposed(a.patient);
      expect((await confirm(b)).status).toBe(201);
      const asks: string[] = [];
      for (const p of [a, b]) {
        // The same borrower accepts a second contract: past the code's resend cooldown.
        await h.redis.del(`identity:challenge-cooldown:contract_acceptance:${p.patient.mobile}`);
        await steps.complete(p.patient, p.applicationId);
        const asked = await w.staff(w.completion, 'POST', '/funding/requests', {
          creditApplicationId: p.applicationId,
        });
        asks.push(asked.body['id'] as string);
      }
      // Only funded loans count: each alone fits (9,600,000), not both (≥ 19,200,000).
      await setCap('15000000', 'obligation', false);
      const results = await Promise.all(
        asks.map((id) => w.staff(finance, 'POST', `/funding/requests/${id}/approve`)),
      );
      expect(
        results.map((r) => r.status).sort(),
        `round ${String(i)}: ${JSON.stringify(results.map((r) => r.body))}`,
      ).toEqual([201, 409]);
    }
  }, 900_000);
});
