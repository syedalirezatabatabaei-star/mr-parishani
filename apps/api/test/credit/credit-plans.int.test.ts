import type { CreditPlan } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '../../src/modules/config/config.service';
import { CreditPlanService } from '../../src/modules/credit/credit-plan.service';
import {
  call,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * Credit plans as versioned configuration and their preview (task 3-3; doc 10 §3):
 * none until defined, a second person to change them, and a preview that a case locked
 * never changes, whatever is approved later (doc 10 §10 test 5).
 */

let h: Harness;
let strategyA: LoggedInAccount;
let strategyB: LoggedInAccount;

const plan = (feeBps: number): CreditPlan => ({
  code: 'dental_12',
  title: 'طرح دندانپزشکی ۱۲ ماهه',
  active: true,
  cityCode: 'isfahan',
  treatmentFieldCodes: ['dentistry'],
  doctorIds: null,
  minAmountRial: '10000000',
  maxAmountRial: '500000000',
  downPayment: { basis: 'percent', bps: 2000 },
  installmentCounts: [6, 12],
  planFee: { basis: 'percent', bps: feeBps, timing: 'spread' },
  originationFee: { basis: 'fixed', rial: '2000000' },
  // ADR-035: a plan added from now on rounds its shares to whole tomans.
  percentRoundingRial: '10',
});

async function approvePlans(plans: CreditPlan[]) {
  const proposed = await call(h, 'POST', '/config/proposals', {
    bearer: strategyA.access,
    body: {
      key: 'credit.plans',
      scope: { level: 'global' },
      value: { plans },
      reason: 'آزمون طرح‌ها',
    },
  });
  expect(proposed.status).toBe(201);
  const id = proposed.body['id'] as string;
  const self = await call(h, 'POST', `/config/proposals/${id}/approve`, {
    bearer: strategyA.access,
  });
  expect(self.status).toBe(403);
  const approved = await call(h, 'POST', `/config/proposals/${id}/approve`, {
    bearer: strategyB.access,
  });
  expect(approved.status).toBe(200);
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  [strategyA, strategyB] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, strategyA.id, 'strategy_manager');
  await grantRole(h, strategyB.id, 'strategy_manager');
});

afterAll(async () => {
  await h.close();
});

describe('credit plans (migration 0022)', () => {
  it('start with no plan, and with loan reduction off', async () => {
    const config = h.app.get(ConfigService);
    expect((await config.resolve('credit.plans')).value).toEqual({ plans: [] });
    expect((await config.resolve('credit.allow_patient_amount_reduction')).value).toBe(false);
    await expect(
      h.app
        .get(CreditPlanService)
        .quote('dental_12', { proformaTotalRial: 100_000_000n, installmentCount: 12 }),
    ).rejects.toMatchObject({ response: { error: 'plan_not_found' } });
  });

  it('refuse a plan with a late penalty or VAT', async () => {
    const res = await call(h, 'POST', '/config/proposals', {
      bearer: strategyA.access,
      body: {
        key: 'credit.plans',
        scope: { level: 'global' },
        value: { plans: [{ ...plan(1500), latePenaltyBps: 200 }] },
        reason: 'آزمون',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('invalid_value');
  });
});

describe('a preview a case locked (doc 10 §10 test 5)', () => {
  it('stays the same after the plans change; a new preview follows the new version', async () => {
    const service = h.app.get(CreditPlanService);
    const firstId = await approvePlans([plan(1500)]);
    const chosen = await service.quote('dental_12', {
      proformaTotalRial: 100_000_000n,
      installmentCount: 12,
    });
    expect(chosen.versions.plansVersionId).toBe(firstId);
    expect(chosen.quote.planFeeRial).toBe(12_000_000n);
    expect(chosen.quote.totalObligationRial).toBe(92_000_000n);

    // The strategy manager raises the fee; a second person approves.
    await approvePlans([plan(2000)]);
    const later = new Date(Date.now() + 1000);
    const locked = await service.quote(
      'dental_12',
      { proformaTotalRial: 100_000_000n, installmentCount: 12 },
      chosen.versions,
      later,
    );
    // Same versions, so the same amounts and installments; only the assumed funding day moves.
    expect(locked.versions).toEqual(chosen.versions);
    expect(locked.quote.planFeeRial).toBe(12_000_000n);
    expect(locked.quote.installments.map((i) => i.amountRial)).toEqual(
      chosen.quote.installments.map((i) => i.amountRial),
    );
    const fresh = await service.quote(
      'dental_12',
      { proformaTotalRial: 100_000_000n, installmentCount: 12 },
      undefined,
      later,
    );
    expect(fresh.versions.plansVersionId).not.toBe(firstId);
    expect(fresh.quote.planFeeRial).toBe(16_000_000n);
  });

  it('refuses what the plan does not offer, by its code', async () => {
    await expect(
      h.app
        .get(CreditPlanService)
        .quote('dental_12', { proformaTotalRial: 100_000_000n, installmentCount: 9 }),
    ).rejects.toMatchObject({ response: { error: 'installment_count_not_in_plan' } });
    await expect(
      h.app.get(CreditPlanService).quote('dental_12', {
        proformaTotalRial: 100_000_000n,
        requestedAmountRial: 50_000_000n,
        installmentCount: 12,
      }),
    ).rejects.toMatchObject({ response: { error: 'amount_reduction_not_allowed' } });
  });
});

describe('ADR-035: a plan added from now on rounds its shares to whole tomans', () => {
  const propose = (plans: CreditPlan[]) =>
    call(h, 'POST', '/config/proposals', {
      bearer: strategyA.access,
      body: { key: 'credit.plans', scope: { level: 'global' }, value: { plans }, reason: 'آزمون' },
    });

  it('refuses a new plan without the rounding; a plan in force keeps what it had', async () => {
    // A plan in force from before ADR-035 (written as the migrations of that time would).
    const legacy: CreditPlan = { ...plan(1500) };
    delete legacy.percentRoundingRial;
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('credit.plans', 'global', $1::jsonb, now(), 'approved', 'پیش از ADR-035', now())`,
      [JSON.stringify({ plans: [{ ...legacy, code: 'legacy_plan' }] })],
    );
    const refused = await propose([
      { ...legacy, code: 'legacy_plan' },
      { ...legacy, code: 'brand_new' },
    ]);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: 'plan_rounding_required',
      plans: ['brand_new'],
    });
    // The plan in force may stay as it is; the new one rounds.
    const accepted = await propose([
      { ...legacy, code: 'legacy_plan' },
      { ...legacy, code: 'brand_new', percentRoundingRial: '10' },
    ]);
    expect(accepted.status).toBe(201);
  });
});
