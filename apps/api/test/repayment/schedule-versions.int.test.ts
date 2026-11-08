import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import { REPAYMENT, type RepaymentPort } from '../../src/common/repayment/repayment.port';
import { createPool } from '../../src/db/pool';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Row } from '../credit/world';
import { startHarness, type Harness, type LoggedInAccount } from '../identity/harness';

/**
 * T1 and T3 [financial] (owner 1405/07/22; ADR-041; migration 0084): a credit application
 * locks, when it is created, the versions of the due-day shift and of the grace days; its
 * schedule is made from them, whatever is approved between creation and funding. The
 * database requires both, and nobody changes them after. The holidays stay those known at
 * funding (T2): holidays.int.test.ts.
 */
let h: Harness;
let app: Pool;
let manager: LoggedInAccount;
let finance: LoggedInAccount;
let w: Awaited<ReturnType<typeof creditWorld>>;

const SHIFT = 'repayment.shift_due_to_next_working_day';
const GRACE = 'repayment.grace_days';
const q = async (text: string, values: unknown[] = []) =>
  (await h.owner.query<Row>(text, values)).rows;
const versionNow = async (key: typeof SHIFT | typeof GRACE) =>
  (await h.app.get<ConfigPort>(CONFIG).resolve(key)).versionId;

/** A new approved global version of `key`, in force from now; its id. */
async function approve(key: string, value: unknown): Promise<string> {
  const [row] = await q(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2, now(), 'approved', 'آزمون ADR-041', now()) RETURNING id`,
    [key, JSON.stringify(value)],
  );
  return row?.['id'] as string;
}

const versionsOf = async (applicationId: string) =>
  (
    await q('SELECT shift_version_id, grace_version_id FROM credit_applications WHERE id = $1', [
      applicationId,
    ])
  )[0] as Row;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  finance = await w.role('accounting');
  app = createPool(h.db.appUrl, 'test-app');
}, 240_000);

afterAll(async () => {
  await app.end();
  await h.close();
});

describe('the schedule’s due-day shift and grace days, locked on the case (ADR-041)', () => {
  it('a case funded after both changed is scheduled with the versions it was created with', async () => {
    const steps = fundingSteps(h, w, { manager, finance });
    const shiftThen = await versionNow(SHIFT);
    const graceThen = await versionNow(GRACE);
    const { patient, applicationId } = await steps.approved();
    expect(await versionsOf(applicationId)).toEqual({
      shift_version_id: shiftThen,
      grace_version_id: graceThen,
    });

    // Both change between the case's creation and its funding.
    const shiftNow = await approve(SHIFT, true);
    const graceNow = await approve(GRACE, 7);
    try {
      expect(await versionNow(SHIFT)).toBe(shiftNow);
      expect(await versionNow(GRACE)).toBe(graceNow);
      await steps.complete(patient, applicationId);
      const purseId = await steps.fund(applicationId);
      const [schedule] = await q(
        `SELECT s.id, s.shift_config_version_id, s.due_dates_shifted, t.grace_days,
                t.grace_config_version_id
         FROM installment_schedules s JOIN installment_schedule_terms t ON t.schedule_id = s.id
         WHERE s.purse_id = $1`,
        [purseId],
      );
      expect(schedule).toMatchObject({
        shift_config_version_id: shiftThen,
        // The case's version did not move due days.
        due_dates_shifted: false,
        grace_days: 0,
        grace_config_version_id: graceThen,
      });
      const repayment = h.app.get<RepaymentPort>(REPAYMENT);
      const view = await repayment.schedule(schedule?.['id'] as string);
      expect(view.graceDays).toBe(0);

      // A case created now locks the new versions.
      const later = await steps.approved();
      expect(await versionsOf(later.applicationId)).toEqual({
        shift_version_id: shiftNow,
        grace_version_id: graceNow,
      });
    } finally {
      await approve(SHIFT, false);
      await approve(GRACE, 0);
    }
  });

  it('the database: both required, never changed after, never left without their version', async () => {
    const columns = await q(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'credit_applications'
         AND column_name IN ('shift_version_id', 'grace_version_id') ORDER BY 1`,
    );
    expect(columns).toEqual([
      { column_name: 'grace_version_id', is_nullable: 'NO' },
      { column_name: 'shift_version_id', is_nullable: 'NO' },
    ]);
    const [row] = await q(
      'SELECT id, shift_version_id FROM credit_applications ORDER BY created_at LIMIT 1',
    );
    const id = row?.['id'] as string;
    const other = await approve(SHIFT, false);
    // The owner: the trigger.
    await expect(
      h.owner.query('UPDATE credit_applications SET shift_version_id = $1 WHERE id = $2', [
        other,
        id,
      ]),
    ).rejects.toThrow(/schedule versions of credit application .* are locked/);
    await expect(
      h.owner.query('UPDATE credit_applications SET grace_version_id = $1 WHERE id = $2', [
        await versionNow(GRACE),
        randomUUID(),
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
    // The application role: no right to the columns at all.
    await expect(
      app.query('UPDATE credit_applications SET shift_version_id = $1 WHERE id = $2', [other, id]),
    ).rejects.toThrow(/permission denied/);
    // The locked version cannot be deleted while the case points to it.
    await expect(
      h.owner.query('DELETE FROM config_values WHERE id = $1', [row?.['shift_version_id']]),
    ).rejects.toThrow();
    expect(
      await q('SELECT count(*)::int AS n FROM config_values WHERE id = $1', [
        row?.['shift_version_id'],
      ]),
    ).toEqual([{ n: 1 }]);
  });

  it('a schedule is never made without the case’s shift and grace versions', async () => {
    const repayment = h.app.get<RepaymentPort>(REPAYMENT);
    const input = {
      idempotencyKey: `t13-${randomUUID()}`,
      purseId: randomUUID(),
      installmentCount: 12,
      planFeeRial: 0n,
      roundingConfigVersionId: randomUUID(),
    };
    for (const bad of [undefined, '', 'not-a-uuid']) {
      await expect(
        repayment.createSchedule(CLI_ACTOR, {
          ...input,
          shiftConfigVersionId: bad as unknown as string,
          graceConfigVersionId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 400, response: { error: 'shift_version_required' } });
      await expect(
        repayment.createSchedule(CLI_ACTOR, {
          ...input,
          shiftConfigVersionId: randomUUID(),
          graceConfigVersionId: bad as unknown as string,
        }),
      ).rejects.toMatchObject({ status: 400, response: { error: 'grace_version_required' } });
    }
  });
});
