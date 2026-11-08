import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool';
import { startHarness, type Harness } from '../identity/harness';
import { fundingSteps } from './funding-steps';
import { CREDIT_HARNESS, creditWorld, type Row } from './world';

/**
 * Rule 16 at the database, not in the code (go-live M1, owner's condition 2): once a case
 * has locked its configuration versions and been decided, neither the application's role
 * nor the owner's can change what it locked, the decision's preview, or the configuration
 * versions themselves. Every attempt is refused and nothing changes.
 */

let h: Harness;
let app: Pool;
let applicationId: string;
let locked: Row;
let versionIds: string[];

const LOCKED_COLUMNS: Record<string, string> = {
  plans_version_id: 'gen_random_uuid()',
  rounding_version_id: 'gen_random_uuid()',
  reduction_version_id: 'gen_random_uuid()',
  installment_count: 'installment_count + 1',
  down_payment_rial: 'down_payment_rial + 1',
  plan_fee_rial: 'plan_fee_rial + 1',
  plan_fee_timing: "CASE plan_fee_timing WHEN 'spread' THEN 'at_completion' ELSE 'spread' END",
  origination_fee_rial: 'origination_fee_rial + 1',
  total_obligation_rial: 'total_obligation_rial + 1',
  loan_rial: 'loan_rial + 1',
};

const SNAPSHOT = `SELECT ${Object.keys(LOCKED_COLUMNS).join(', ')}, approved_amount_rial
  FROM credit_applications WHERE id = $1`;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  app = createPool(h.db.appUrl, 'test-app');
  const w = await creditWorld(h);
  const manager = await w.role('credit_manager');
  ({ applicationId } = await fundingSteps(h, w, { manager, finance: manager }).approved());
  locked = (await h.owner.query<Row>(SNAPSHOT, [applicationId])).rows[0] ?? {};
  versionIds = ['plans_version_id', 'rounding_version_id', 'reduction_version_id'].map(
    (c) => locked[c] as string,
  );
}, 300_000);

afterAll(async () => {
  await app.end();
  await h.close();
});

describe('a decided case keeps what it locked (rule 16, at the database)', () => {
  it('locked the three versions and was decided', async () => {
    expect(versionIds.every((id) => typeof id === 'string')).toBe(true);
    expect(locked['approved_amount_rial']).not.toBeNull();
    const { rows } = await h.owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM config_values WHERE id = ANY($1::uuid[]) AND status = 'approved'",
      [versionIds],
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });

  it.each(Object.entries(LOCKED_COLUMNS))(
    'credit_applications.%s: the app role has no grant, the owner is stopped by the trigger',
    async (column, expression) => {
      const statement = `UPDATE credit_applications SET ${column} = ${expression} WHERE id = $1`;
      await expect(app.query(statement, [applicationId])).rejects.toMatchObject({
        code: '42501',
      });
      await expect(h.owner.query(statement, [applicationId])).rejects.toMatchObject({
        code: '23514',
        message: expect.stringMatching(/can only change its state/) as unknown,
      });
    },
  );

  it('the approved amount, once decided, is refused to both roles', async () => {
    const statement =
      'UPDATE credit_applications SET approved_amount_rial = approved_amount_rial + 1 WHERE id = $1';
    for (const pool of [app, h.owner]) {
      await expect(pool.query(statement, [applicationId])).rejects.toMatchObject({
        code: '23514',
        message: expect.stringMatching(/was decided/) as unknown,
      });
    }
  });

  it("the decision's preview (quote) is refused to both roles", async () => {
    const statement = `UPDATE credit_decisions SET quote = '{}'::jsonb
      WHERE credit_application_id = $1 AND status = 'decided'`;
    await expect(app.query(statement, [applicationId])).rejects.toMatchObject({ code: '42501' });
    await expect(h.owner.query(statement, [applicationId])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('neither the application nor its decision can be deleted', async () => {
    for (const table of ['credit_applications', 'credit_decisions']) {
      const column = table === 'credit_applications' ? 'id' : 'credit_application_id';
      const statement = `DELETE FROM ${table} WHERE ${column} = $1`;
      await expect(app.query(statement, [applicationId])).rejects.toMatchObject({
        code: '42501',
      });
      await expect(h.owner.query(statement, [applicationId])).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/append-only/) as unknown,
      });
    }
  });

  it('the locked configuration versions: value, scope, start and soft delete never change', async () => {
    for (const set of [
      "value = '{}'::jsonb",
      'deleted_at = now()',
      "scope_level = 'city'",
      "effective_at = effective_at + interval '1 day'",
      "status = 'rejected'",
    ]) {
      const statement = `UPDATE config_values SET ${set} WHERE id = $1`;
      for (const id of versionIds) {
        await expect(app.query(statement, [id])).rejects.toMatchObject({
          code: expect.stringMatching(/^(42501|23514)$/) as unknown,
        });
        await expect(h.owner.query(statement, [id])).rejects.toMatchObject({ code: '23514' });
      }
    }
    for (const id of versionIds) {
      await expect(app.query('DELETE FROM config_values WHERE id = $1', [id])).rejects.toMatchObject(
        { code: '42501' },
      );
    }
  });

  it('no role, not even the owner, deletes or truncates a configuration version (0082)', async () => {
    for (const id of versionIds) {
      await expect(
        h.owner.query('DELETE FROM config_values WHERE id = $1', [id]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/config_values is append-only/) as unknown,
      });
    }
    // Plain TRUNCATE is stopped by the foreign keys before any trigger; with CASCADE it reaches
    // the statement trigger.
    await expect(h.owner.query('TRUNCATE config_values')).rejects.toMatchObject({
      code: '0A000',
    });
    await expect(h.owner.query('TRUNCATE config_values CASCADE')).rejects.toMatchObject({
      code: '42501',
      message: expect.stringMatching(/is append-only/) as unknown,
    });
  });

  it('every locked version column references config_values, validated, ON DELETE RESTRICT (0082)', async () => {
    const { rows } = await h.owner.query<{ conname: string; target: string; valid: boolean; del: string }>(
      `SELECT conname, confrelid::regclass::text AS target, convalidated AS valid, confdeltype AS del
       FROM pg_constraint WHERE contype = 'f' AND conname = ANY($1::text[]) ORDER BY conname`,
      [
        [
          'credit_applications_plans_version_fk',
          'credit_applications_rounding_version_fk',
          'credit_applications_reduction_version_fk',
          'installment_schedules_rounding_version_fk',
          'installment_schedules_shift_version_fk',
          'installment_schedules_weekly_version_fk',
          'installment_schedule_terms_grace_version_fk',
          'contract_penalty_terms_version_fk',
        ],
      ],
    );
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row).toMatchObject({ target: 'config_values', valid: true, del: 'r' });
    }
  });

  it('after every attempt, the case and its versions are exactly as they were', async () => {
    expect((await h.owner.query<Row>(SNAPSHOT, [applicationId])).rows[0]).toEqual(locked);
    const { rows } = await h.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM config_values
       WHERE id = ANY($1::uuid[]) AND status = 'approved' AND deleted_at IS NULL`,
      [versionIds],
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });
});
