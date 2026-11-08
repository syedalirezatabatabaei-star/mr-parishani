import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool';
import { CREDIT_HARNESS, creditWorld } from '../credit/world';
import { startHarness, type Harness } from '../identity/harness';

/**
 * Migration 0079 (task 9-3, R4; owner 1405/07/18): the centers' guard lets a re-encryption
 * run rewrite a center's encrypted identifier and Sheba and their blind indexes only when all
 * three hold: the table's owner, a run recorded as running in field_reencryption_runs, and
 * nothing but those columns changed. Anyone else, without a running run, or with any other
 * column changed, gets the guard's refusal. Every attempt is rolled back.
 */
let h: Harness;
let app: Pool;
let centerId = '';
let running = '';
let completed = '';

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  await creditWorld(h);
  app = createPool(h.db.appUrl, 'test-app');
  const [center] = (
    await h.owner.query<{ id: string }>(
      `SELECT id FROM centers WHERE status = 'active' AND first_activated_at IS NOT NULL
       ORDER BY created_at LIMIT 1`,
    )
  ).rows;
  centerId = center?.id ?? '';
  const run = async (outcome: 'running' | 'completed') =>
    (
      await h.owner.query<{ id: string }>(
        `INSERT INTO field_reencryption_runs (authorization_version_id, backup_file, outcome, finished_at)
         VALUES ($1, 'test.dump', $2, CASE WHEN $2 = 'running' THEN NULL ELSE now() END)
         RETURNING id`,
        [randomUUID(), outcome],
      )
    ).rows[0]?.id ?? '';
  running = await run('running');
  completed = await run('completed');
}, 180_000);

afterAll(async () => {
  await app.end();
  await h.close();
});

/** One UPDATE of the center in its own transaction, rolled back: null if allowed, else the error. */
async function attempt(pool: Pool, runId: string | null, set: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (runId !== null) {
      await client.query(`SELECT set_config('sepehr.field_reencryption_run', $1, true)`, [runId]);
    }
    const done = await client.query(`UPDATE centers SET ${set} WHERE id = $1`, [centerId]);
    expect(done.rowCount).toBe(1);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'error';
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const KEYS_ONLY = `identifier_index = 'k2.test-identifier', sheba_index = 'k2.test-sheba',
  identifier_enc = 'k2.a.b.c', sheba_enc = 'k2.d.e.f'`;
const REFUSED = /cannot change|changes only by an approved two-person request/;

describe('the centers’ guard and a re-encryption run (0079)', () => {
  it('lets the owner, inside a running run, rewrite only the encrypted columns and indexes', async () => {
    expect(centerId).not.toBe('');
    expect(await attempt(h.owner, running, KEYS_ONLY)).toBeNull();
  });

  it('refuses the owner without a run, with a finished run, or with a run never recorded', async () => {
    expect(await attempt(h.owner, null, KEYS_ONLY)).toMatch(REFUSED);
    expect(await attempt(h.owner, completed, KEYS_ONLY)).toMatch(REFUSED);
    expect(await attempt(h.owner, randomUUID(), KEYS_ONLY)).toMatch(REFUSED);
    expect(await attempt(h.owner, 'not-a-uuid', KEYS_ONLY)).toMatch(REFUSED);
  });

  it('refuses a run that changes anything else with them', async () => {
    for (const other of [
      `account_holder_name = 'کسی دیگر'`,
      `person_type = CASE person_type WHEN 'natural' THEN 'legal' ELSE 'natural' END`,
      `status = 'suspended'`,
      `name = 'نام دیگر'`,
    ]) {
      expect(await attempt(h.owner, running, `${KEYS_ONLY}, ${other}`), other).not.toBeNull();
    }
  });

  it('refuses the application role, even naming a running run: the guard, not a missing right', async () => {
    const error = await attempt(app, running, KEYS_ONLY);
    expect(error).toMatch(REFUSED);
    expect(error).not.toMatch(/permission denied/);
  });

  it('still keeps the bank account to its two-person path outside a run', async () => {
    expect(await attempt(h.owner, null, `sheba_index = 'k2.other'`)).toMatch(
      /changes only by an approved two-person request/,
    );
    expect(await attempt(app, null, `identifier_index = 'k2.other'`)).toMatch(/cannot change/);
  });
});
