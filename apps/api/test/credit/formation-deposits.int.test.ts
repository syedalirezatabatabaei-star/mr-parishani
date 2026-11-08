import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { fundingSteps } from './funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from './world';

/**
 * The formation deposit (owner 1405/07/29, answer f; migration 0100): the pilot records its
 * details only. Its amount is the business number credit.formation_deposit_rial ("0" = off),
 * locked on the record with its version; one per application; its refund is recorded once and
 * only before the introduction letter (the default: the purse's charge). Never a ledger row.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let app: Pool;
let steps: ReturnType<typeof fundingSteps>;
let strategyA: Staff;
let strategyB: Staff;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  app = createPool(h.db.appUrl, 'test-app');
  const manager = await w.role('credit_manager');
  const finance = await w.role('accounting');
  steps = fundingSteps(h, w, { manager, finance });
  strategyA = await w.role('strategy_manager');
  strategyB = await w.role('strategy_manager');
}, 180_000);

afterAll(async () => {
  await app.end();
  await h.close();
});

const BANK_REF = 'TRK-778899001234';

/** The deposit amount, set by two people as any business number. */
async function setDeposit(rial: string) {
  const proposal = await w.staff(strategyA, 'POST', '/config/proposals', {
    key: 'credit.formation_deposit_rial',
    scope: { level: 'global' },
    value: rial,
    reason: 'بیعانه تشکیل، آزمون',
  });
  expect(proposal.status).toBe(201);
  const done = await w.staff(
    strategyB,
    'POST',
    `/config/proposals/${proposal.body['id'] as string}/approve`,
  );
  expect(done.status).toBe(200);
}

const record = (who: Staff, applicationId: string, body: Body = {}) =>
  w.staff(who, 'POST', `/credit/applications/${applicationId}/formation-deposit`, {
    paidOn: '2026-10-20',
    bankReference: BANK_REF,
    note: 'پرداخت در شعبه',
    ...body,
  });
const refund = (who: Staff, applicationId: string, body: Body = {}) =>
  w.staff(who, 'POST', `/credit/applications/${applicationId}/formation-deposit/refund`, {
    refundedOn: '2026-10-21',
    refundReference: 'RF-55443322',
    reason: 'بیمار پیش از معرفی‌نامه انصراف داد',
    ...body,
  });
const state = (who: Staff, applicationId: string) =>
  w.staff(who, 'GET', `/credit/applications/${applicationId}/formation-deposit`);

async function ledgerCount() {
  const { rows } = await h.owner.query<Row>('SELECT count(*)::int AS n FROM ledger_entries');
  return rows[0]?.['n'] as number;
}

describe('the formation deposit (owner 1405/07/29, answer f)', () => {
  it('is off until two people set its amount: nothing is recorded at "0"', async () => {
    const { applicationId } = await steps.approved();
    const now = await state(w.completion, applicationId);
    expect(now.status).toBe(200);
    expect(now.body).toEqual({ deposit: null, configuredAmountRial: '0' });
    const refused = await record(w.completion, applicationId);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('formation_deposit_off');
  });

  it('records the details with the amount and version locked, once, and no ledger row', async () => {
    await setDeposit('990000');
    const { applicationId } = await steps.approved();
    const before = await ledgerCount();

    const made = await record(w.completion, applicationId);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      creditApplicationId: applicationId,
      amountRial: '990000',
      paidOn: '2026-10-20',
      bankReferenceLast4: '1234',
      note: 'پرداخت در شعبه',
      refund: null,
      refundable: true,
    });
    // The version the amount came from, locked on the row (rule 16).
    const { rows } = await h.owner.query<Row>(
      `SELECT d.config_version_id = v.id AS locked
       FROM credit_formation_deposits d
       JOIN config_values v ON v.key = 'credit.formation_deposit_rial' AND v.status = 'approved'
       WHERE d.credit_application_id = $1
       ORDER BY v.effective_at DESC LIMIT 1`,
      [applicationId],
    );
    expect(rows[0]?.['locked']).toBe(true);

    // One per application.
    const again = await record(w.completion, applicationId, { bankReference: 'TRK-000' });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('deposit_exists');

    // A later amount changes only later records.
    await setDeposit('500000');
    expect(((await state(w.completion, applicationId)).body['deposit'] as Body)['amountRial']).toBe(
      '990000',
    );
    expect((await state(w.completion, applicationId)).body['configuredAmountRial']).toBe('500000');
    const { applicationId: later } = await steps.approved();
    expect((await record(w.completion, later)).body['amountRial']).toBe('500000');

    // Details only: the ledger did not move.
    expect(await ledgerCount()).toBe(before);
    // The audit keeps the reference's last four only.
    const { rows: audits } = await h.owner.query<Row>(
      `SELECT after::text AS after FROM audit_events
       WHERE action = 'credit.formation_deposit_recorded' AND entity_id = $1`,
      [applicationId],
    );
    expect(audits).toHaveLength(1);
    expect(String(audits[0]?.['after'])).toContain('1234');
    expect(String(audits[0]?.['after'])).not.toContain(BANK_REF);
  });

  it('records a refund once, before the purse is charged, never before the payment day', async () => {
    const { applicationId } = await steps.approved();
    expect((await record(w.completion, applicationId)).status).toBe(201);
    const early = await refund(w.completion, applicationId, { refundedOn: '2026-10-19' });
    expect(early.status).toBe(409);
    expect(early.body['error']).toBe('refund_before_payment');

    const before = await ledgerCount();
    const done = await refund(w.completion, applicationId);
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({
      refund: {
        refundedOn: '2026-10-21',
        refundReferenceLast4: '3322',
        reason: 'بیمار پیش از معرفی‌نامه انصراف داد',
      },
      refundable: false,
    });
    expect(await ledgerCount()).toBe(before);

    const twice = await refund(w.completion, applicationId);
    expect(twice.status).toBe(409);
    expect(twice.body['error']).toBe('already_refunded');

    // No deposit, nothing to refund.
    const { applicationId: none } = await steps.approved();
    const missing = await refund(w.completion, none);
    expect(missing.status).toBe(404);
    expect(missing.body['error']).toBe('deposit_not_found');
  });

  it('is not refunded once the purse is charged (the introduction letter, by default)', async () => {
    const { patient, applicationId } = await steps.approved();
    expect((await record(w.completion, applicationId)).status).toBe(201);
    await steps.complete(patient, applicationId);
    await steps.fund(applicationId);

    const shown = await state(w.completion, applicationId);
    expect((shown.body['deposit'] as Body)['refundable']).toBe(false);
    const refused = await refund(w.completion, applicationId);
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('deposit_non_refundable');
    const { rows } = await h.owner.query<Row>(
      'SELECT refunded_at FROM credit_formation_deposits WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(rows[0]?.['refunded_at']).toBeNull();
  });

  it('only case completion records; credit units read; another city sees nothing', async () => {
    const { applicationId } = await steps.approved();
    // Has credit.read_applications, not credit.record_formation_deposit.
    const reader = w.creditSpecialist;
    expect((await state(reader, applicationId)).status).toBe(200);
    const denied = await record(reader, applicationId);
    expect(denied.status).toBe(403);
    expect((await refund(reader, applicationId)).status).toBe(403);
    // Neither permission.
    const outsider = await w.role('network_manager');
    expect((await state(outsider, applicationId)).status).toBe(403);
    // Case completion of another city: as if it did not exist (rule 13).
    const elsewhere = await w.role('case_completion', { kind: 'city', code: 'isfahan' });
    const hidden = await record(elsewhere, applicationId);
    expect(hidden.status).toBe(404);
    expect(hidden.body['error']).toBe('credit_application_not_found');
    expect((await state(elsewhere, applicationId)).status).toBe(404);
  });

  it('the database keeps a recorded deposit as it was and refuses deleting it', async () => {
    const { applicationId } = await steps.approved();
    const made = await record(w.completion, applicationId);
    const id = made.body['id'] as string;
    await expect(
      h.owner.query('UPDATE credit_formation_deposits SET amount_rial = 1 WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.owner.query(`UPDATE credit_formation_deposits SET bank_reference = 'XYZ-1' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // A partial refund breaks the all-or-none check.
    await expect(
      h.owner.query(
        `UPDATE credit_formation_deposits SET refunded_on = '2026-10-21' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query('DELETE FROM credit_formation_deposits WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '42501' });
    // Once refunded, the refund does not change either.
    expect((await refund(w.completion, applicationId)).status).toBe(201);
    await expect(
      h.owner.query(
        `UPDATE credit_formation_deposits SET refund_reason = 'دلیل دیگر' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
