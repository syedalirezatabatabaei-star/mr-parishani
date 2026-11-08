import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersonBackfill } from '../../src/modules/identity/person-backfill';
import { newMobile, startHarness, type Harness } from './harness';

let h: Harness;

const query = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await h.owner.query(text, values)).rows as T[];

const personOf = async (accountId: string | undefined) =>
  (await query('SELECT person_id FROM user_accounts WHERE id = $1', [accountId]))[0]?.['person_id'];

const personsWithMobile = async (mobile: string) =>
  (
    await query<{ n: number }>('SELECT count(*)::int AS n FROM person_mobiles WHERE mobile = $1', [
      mobile,
    ])
  )[0]?.n;

beforeAll(async () => {
  // The real PERSON_DIRECTORY of the lead module (no fake).
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('pnpm lead:backfill-persons (task 2-5b decision 1)', () => {
  it('never links a shared or invalid mobile: those go to manual review with their reason', async () => {
    // Accounts made before the lead module. A clean one, and, as legacy data that slipped
    // past the checks, two accounts whose mobiles are one number written two ways and one
    // with a mobile that is not a mobile. Today's schema refuses such rows
    // (user_accounts_login_key_check), so only in this throwaway database the check is
    // lifted to write them, and put back NOT VALID (still checked for every new row).
    const clean = newMobile();
    const shared = newMobile();
    const [plain] = await query<{ id: string }>(
      `INSERT INTO user_accounts (kind, mobile) VALUES ('patient', $1) RETURNING id`,
      [clean],
    );
    const [check] = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'user_accounts_login_key_check'`,
    );
    await h.owner.query('ALTER TABLE user_accounts DROP CONSTRAINT user_accounts_login_key_check');
    const legacy = async (mobile: string) =>
      (
        await query<{ id: string }>(
          `INSERT INTO user_accounts (kind, mobile) VALUES ('patient', $1) RETURNING id`,
          [mobile],
        )
      )[0]?.id;
    const sharedA = await legacy(shared);
    const sharedB = await legacy(`0${shared}`);
    const invalid = await legacy('12345');
    await h.owner.query(
      `ALTER TABLE user_accounts ADD CONSTRAINT user_accounts_login_key_check ${String(check?.def)} NOT VALID`,
    );
    const expectedReview = [
      { accountId: sharedA, reason: 'shared_mobile' },
      { accountId: sharedB, reason: 'shared_mobile' },
      { accountId: invalid, reason: 'invalid_mobile' },
    ];
    const backfill = h.app.get(PersonBackfill);

    // Dry run: 4 accounts without a person, 1 would be linked, 3 for review; nothing changes.
    const dry = await backfill.run('dry_run');
    expect(dry).toMatchObject({ mode: 'dry_run', candidates: 4, filled: 1 });
    expect(dry.manualReview).toHaveLength(3);
    expect(dry.manualReview).toEqual(expect.arrayContaining(expectedReview));
    expect(await personOf(plain?.id)).toBeNull();
    expect(await personsWithMobile(clean)).toBe(0);

    // Apply: only the clean one is linked; the others get no person, and no person is made
    // for the shared number.
    const applied = await backfill.run('apply');
    expect(applied).toMatchObject({ mode: 'apply', candidates: 4, filled: 1 });
    expect(applied.manualReview).toEqual(expect.arrayContaining(expectedReview));
    const [cleanPerson] = await query('SELECT person_id FROM person_mobiles WHERE mobile = $1', [
      clean,
    ]);
    expect(await personOf(plain?.id)).toBe(cleanPerson?.['person_id']);
    expect(await personOf(sharedA)).toBeNull();
    expect(await personOf(sharedB)).toBeNull();
    expect(await personOf(invalid)).toBeNull();
    expect(await personsWithMobile(shared)).toBe(0);

    // Again: idempotent; the same three still wait for a person to decide.
    const again = await backfill.run('apply');
    expect(again).toMatchObject({ candidates: 3, filled: 0 });
    expect(again.manualReview).toEqual(expect.arrayContaining(expectedReview));

    // Every run recorded with its counts and review list (account ids, never a mobile).
    const runs = await query<{
      mode: string;
      candidates: number;
      filled: number;
      manual_review: unknown[];
    }>(
      'SELECT mode, candidates, filled, manual_review FROM person_backfill_runs ORDER BY created_at',
    );
    expect(runs.map((r) => [r.mode, r.candidates, r.filled, r.manual_review.length])).toEqual([
      ['dry_run', 4, 1, 3],
      ['apply', 4, 1, 3],
      ['apply', 3, 0, 3],
    ]);
    expect(JSON.stringify(runs)).not.toContain(shared);
    // One audited link, for the clean account only.
    const links = await query<{ entity_id: string }>(
      `SELECT entity_id FROM audit_events WHERE action = 'identity.person_linked'`,
    );
    expect(links.map((l) => l.entity_id)).toEqual([plain?.id]);
  });
});
