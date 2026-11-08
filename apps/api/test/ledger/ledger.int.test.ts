import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import type { JournalLine, PostJournal } from '../../src/common/ledger/ledger.port';
import { createPool } from '../../src/db/pool';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { call, grantRole, loggedInAccount, startHarness, type Harness } from '../identity/harness';

let h: Harness;
let app: Pool;
let ledger: LedgerService;
/** Accounts of the test: two borrowers' purses, company income, a bank account. */
const acc = { a: '', b: '', income: '', bank: '', otherEntity: '' };
let counter = 0;
const key = (label: string) => `test-${label}-${String(++counter)}-${String(Date.now())}`;

const line = (
  accountId: string,
  direction: 'debit' | 'credit',
  amountRial: bigint,
): JournalLine => ({
  accountId,
  direction,
  amountRial,
});

const journal = (lines: JournalLine[], overrides: Partial<PostJournal> = {}): PostJournal => ({
  entityId: 'aramesh',
  eventType: 'wallet.test_posting',
  occurredAt: new Date('2026-09-27T08:00:00Z'),
  idempotencyKey: key('j'),
  lines,
  ...overrides,
});

/** Same seed, same numbers: a failing property run can be replayed exactly. */
function mulberry32(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
  ledger = h.app.get(LedgerService);
  const open = (code: string, kind: 'memo' | 'income' | 'asset', ownerId: string | null) =>
    ledger
      .openAccount({
        entityId: 'aramesh',
        code,
        name: code,
        kind,
        ownerType: ownerId ? 'borrower' : 'company',
        ownerId,
      })
      .then((r) => r.id);
  acc.a = await open('purse.available', 'memo', '01a0e1e7-0000-7000-8000-00000000000a');
  acc.b = await open('purse.available', 'memo', '01a0e1e7-0000-7000-8000-00000000000b');
  acc.income = await open('company.fee_income', 'income', null);
  acc.bank = await open('bank.collection', 'asset', null);
  acc.otherEntity = (
    await ledger.openAccount({
      entityId: 'sepehr',
      code: 'bank.collection',
      name: 'sepehr bank',
      kind: 'asset',
      ownerType: 'company',
      ownerId: null,
    })
  ).id;
});

afterAll(async () => {
  await app.end();
  await h.close();
});

async function inAppTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('ACCEPTANCE: the application cannot change the ledger; unbalanced documents are refused', () => {
  it('a direct UPDATE or DELETE fails, for the application and even for the schema owner', async () => {
    await ledger.postJournal(
      CLI_ACTOR,
      journal([line(acc.bank, 'debit', 1000n), line(acc.income, 'credit', 1000n)]),
    );
    for (const statement of [
      'UPDATE ledger_entries SET amount_rial = 1',
      'DELETE FROM ledger_entries',
      "UPDATE journal_entries SET reason = 'x'",
      'DELETE FROM journal_entries',
    ]) {
      await expect(app.query(statement)).rejects.toMatchObject({ code: '42501' });
      await expect(h.owner.query(statement)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(h.owner.query('TRUNCATE ledger_entries')).rejects.toMatchObject({ code: '42501' });
  });

  it('postJournal refuses an unbalanced document', async () => {
    await expect(
      ledger.postJournal(
        CLI_ACTOR,
        journal([line(acc.bank, 'debit', 1000n), line(acc.income, 'credit', 999n)]),
      ),
    ).rejects.toMatchObject({ status: 400, response: { error: 'unbalanced_journal' } });
  });

  it('and the database refuses one at commit, whatever the code does', async () => {
    await expect(
      inAppTransaction(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO journal_entries (entity_id, event_type, occurred_at, idempotency_key, request_hash)
           VALUES ('aramesh', 'wallet.sneaky', now(), $1, repeat('a', 64)) RETURNING id`,
          [key('raw')],
        );
        await c.query(
          `INSERT INTO ledger_entries (journal_entry_id, account_id, direction, amount_rial)
           VALUES ($1, $2, 'debit', 500), ($1, $3, 'credit', 400)`,
          [rows[0]?.id, acc.bank, acc.income],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    // A document without entries at all, too.
    await expect(
      inAppTransaction((c) =>
        c.query(
          `INSERT INTO journal_entries (entity_id, event_type, occurred_at, idempotency_key, request_hash)
           VALUES ('aramesh', 'wallet.sneaky', now(), $1, repeat('a', 64))`,
          [key('empty')],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('entries cannot be added to an existing document later', async () => {
    const posted = await ledger.postJournal(
      CLI_ACTOR,
      journal([line(acc.bank, 'debit', 700n), line(acc.income, 'credit', 700n)]),
    );
    await expect(
      inAppTransaction((c) =>
        c.query(
          `INSERT INTO ledger_entries (journal_entry_id, account_id, direction, amount_rial)
           VALUES ($1, $2, 'debit', 5), ($1, $3, 'credit', 5)`,
          [posted.id, acc.bank, acc.income],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('doc 02 §8 invariants', () => {
  it('INVARIANT 1: debits equal credits in every document (500 random documents)', async () => {
    const random = mulberry32(20260927);
    const accounts = [acc.a, acc.b, acc.income, acc.bank];
    const pick = () => accounts[Math.floor(random() * accounts.length)] ?? acc.a;
    for (let i = 0; i < 500; i++) {
      // 1–4 debit lines, balanced by 1–4 credit lines splitting the same total.
      const debits = Array.from(
        { length: 1 + Math.floor(random() * 4) },
        () => BigInt(1 + Math.floor(random() * 1e9)) * BigInt(1 + Math.floor(random() * 1e6)),
      );
      const total = debits.reduce((s, d) => s + d, 0n);
      const creditCount = 1 + Math.floor(random() * 4);
      const credits: bigint[] = [];
      let left = total;
      for (let c = 1; c < creditCount && left > 1n; c++) {
        const part = 1n + ((left - 1n) * BigInt(Math.floor(random() * 1000))) / 1000n;
        if (part >= left) break;
        credits.push(part);
        left -= part;
      }
      credits.push(left);
      await ledger.postJournal(
        CLI_ACTOR,
        journal([
          ...debits.map((d) => line(pick(), 'debit', d)),
          ...credits.map((c) => line(pick(), 'credit', c)),
        ]),
      );
    }
    const { rows } = await h.owner.query<{
      unbalanced: number;
      total_debit: string;
      total_credit: string;
    }>(`
      SELECT
        (SELECT count(*)::int FROM (
           SELECT journal_entry_id FROM ledger_entries GROUP BY journal_entry_id
           HAVING sum(amount_rial) FILTER (WHERE direction = 'debit')
               <> sum(amount_rial) FILTER (WHERE direction = 'credit')
        ) u) AS unbalanced,
        (SELECT sum(amount_rial)::text FROM ledger_entries WHERE direction = 'debit') AS total_debit,
        (SELECT sum(amount_rial)::text FROM ledger_entries WHERE direction = 'credit') AS total_credit
    `);
    expect(rows[0]?.unbalanced).toBe(0);
    expect(rows[0]?.total_debit).toBe(rows[0]?.total_credit);
  }, 120_000);

  it('INVARIANT 3: repeating an idempotency key never creates a second document', async () => {
    const input = journal([line(acc.bank, 'debit', 5000n), line(acc.income, 'credit', 5000n)]);
    const first = await ledger.postJournal(CLI_ACTOR, input);
    const again = await ledger.postJournal(CLI_ACTOR, input);
    expect(again).toMatchObject({ id: first.id, replayed: true });

    // Twenty at once with one key: one document.
    const concurrent = journal([line(acc.a, 'debit', 42n), line(acc.b, 'credit', 42n)]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ledger.postJournal(CLI_ACTOR, concurrent)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const { rows } = await h.owner.query(
      'SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1',
      [concurrent.idempotencyKey],
    );
    expect(rows[0]).toEqual({ n: 1 });

    // The same key with other content is refused, not silently replayed.
    await expect(
      ledger.postJournal(CLI_ACTOR, {
        ...input,
        lines: [line(acc.bank, 'debit', 5001n), line(acc.income, 'credit', 5001n)],
      }),
    ).rejects.toMatchObject({ status: 409, response: { error: 'idempotency_key_reused' } });
  });

  it('INVARIANT 8: a reversal returns every balance exactly to where it was', async () => {
    const before = await Promise.all([acc.a, acc.b, acc.bank].map((id) => ledger.balanceOf(id)));
    const original = await ledger.postJournal(
      CLI_ACTOR,
      journal([
        line(acc.a, 'debit', 1_234_567_890_123n),
        line(acc.b, 'credit', 1_000_000_000_000n),
        line(acc.bank, 'credit', 234_567_890_123n),
      ]),
    );
    const reversalKey = key('rev');
    const reversal = await ledger.reverseJournal(CLI_ACTOR, original.id, {
      idempotencyKey: reversalKey,
      reason: 'ثبت اشتباه',
    });
    expect(reversal.reversesJournalEntryId).toBe(original.id);
    const after = await Promise.all([acc.a, acc.b, acc.bank].map((id) => ledger.balanceOf(id)));
    expect(after.map((b) => b.netDebitRial)).toEqual(before.map((b) => b.netDebitRial));

    // A retry returns the same reversal; a second reversal, or reversing it, is refused.
    expect(
      await ledger.reverseJournal(CLI_ACTOR, original.id, {
        idempotencyKey: reversalKey,
        reason: 'ثبت اشتباه',
      }),
    ).toMatchObject({ id: reversal.id, replayed: true });
    await expect(
      ledger.reverseJournal(CLI_ACTOR, original.id, {
        idempotencyKey: key('rev2'),
        reason: 'دوباره',
      }),
    ).rejects.toMatchObject({ status: 409, response: { error: 'already_reversed' } });
    await expect(
      ledger.reverseJournal(CLI_ACTOR, reversal.id, {
        idempotencyKey: key('rev3'),
        reason: 'برگشت برگشت',
      }),
    ).rejects.toMatchObject({ status: 409, response: { error: 'cannot_reverse_a_reversal' } });
  });
});

describe('postJournal', () => {
  it('never takes a JS number, a non-positive amount or a single line', async () => {
    const bad = [
      [line(acc.bank, 'debit', 100 as unknown as bigint), line(acc.income, 'credit', 100n)],
      [line(acc.bank, 'debit', 0n), line(acc.income, 'credit', 0n)],
      [line(acc.bank, 'debit', -5n), line(acc.income, 'credit', -5n)],
      [line(acc.bank, 'debit', 100n)],
    ];
    for (const lines of bad) {
      await expect(ledger.postJournal(CLI_ACTOR, journal(lines))).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(
      ledger.postJournal(
        CLI_ACTOR,
        journal([line(acc.bank, 'debit', 1n), line(acc.income, 'credit', 1n)], {
          idempotencyKey: '',
        }),
      ),
    ).rejects.toMatchObject({ response: { error: 'idempotency_key_required' } });
  });

  it('keeps each document within one legal entity', async () => {
    await expect(
      ledger.postJournal(
        CLI_ACTOR,
        journal([line(acc.bank, 'debit', 10n), line(acc.otherEntity, 'credit', 10n)]),
      ),
    ).rejects.toMatchObject({ response: { error: 'account_of_another_entity' } });
  });

  it('opposite postings on the same accounts, all at once, do not deadlock', async () => {
    const before = await ledger.balanceOf(acc.a);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        ledger.postJournal(
          CLI_ACTOR,
          journal(
            i % 2 === 0
              ? [line(acc.a, 'debit', 10n), line(acc.b, 'credit', 10n)]
              : [line(acc.b, 'debit', 10n), line(acc.a, 'credit', 10n)],
          ),
        ),
      ),
    );
    expect((await ledger.balanceOf(acc.a)).netDebitRial).toBe(before.netDebitRial);
  });

  it('writes the entries into the month partition, and the event into the outbox, in one transaction', async () => {
    const posted = await ledger.postJournal(
      CLI_ACTOR,
      journal([line(acc.bank, 'debit', 77n), line(acc.income, 'credit', 77n)]),
    );
    const month = new Date().toISOString().slice(0, 7).replace('-', '_');
    const { rows } = await h.owner.query<{ part: string }>(
      'SELECT DISTINCT tableoid::regclass::text AS part FROM ledger_entries WHERE journal_entry_id = $1',
      [posted.id],
    );
    expect(rows).toEqual([{ part: `ledger_entries_${month}` }]);
    const events = await h.owner.query(
      "SELECT payload FROM outbox_events WHERE event_type = 'ledger.journal_posted' AND aggregate_id = $1",
      [posted.id],
    );
    expect(events.rows).toEqual([
      {
        payload: {
          journalEntryId: posted.id,
          entityId: 'aramesh',
          eventType: 'wallet.test_posting',
          reversesJournalEntryId: null,
        },
      },
    ]);
  });

  it('rolls back with the caller: nothing is left of a posting whose transaction fails', async () => {
    const input = journal([line(acc.bank, 'debit', 88n), line(acc.income, 'credit', 88n)]);
    await expect(
      h.app.get(LedgerService)['db'].transaction(async (tx) => {
        await ledger.postJournal(CLI_ACTOR, input, tx);
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    const { rows } = await h.owner.query(
      'SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe('reading', () => {
  it('auditors and accounting read documents and balances as strings of rials', async () => {
    const posted = await ledger.postJournal(
      CLI_ACTOR,
      journal([
        line(acc.bank, 'debit', 9_007_199_254_740_993n),
        line(acc.income, 'credit', 9_007_199_254_740_993n),
      ]),
    );
    const auditor = await loggedInAccount(h, 'staff');
    await grantRole(h, auditor.id, 'auditor');
    const res = await call(h, 'GET', `/ledger/journals/${posted.id}`, { bearer: auditor.access });
    expect(res.status).toBe(200);
    // Beyond 2^53: exact only as a string.
    expect(res.body['lines']).toContainEqual(
      expect.objectContaining({ amountRial: '9007199254740993' }),
    );
    const balance = await call(h, 'GET', `/ledger/accounts/${acc.bank}/balance`, {
      bearer: auditor.access,
    });
    expect(balance.body).toMatchObject({ accountId: acc.bank });
    expect(typeof balance.body['netDebitRial']).toBe('string');

    const nobody = await loggedInAccount(h, 'staff');
    expect(
      (await call(h, 'GET', `/ledger/journals/${posted.id}`, { bearer: nobody.access })).status,
    ).toBe(403);
  });
});

describe('findAccount (task 4-6b): reads, never opens', () => {
  it('finds an account by entity, code and owner, and creates none when it is missing', async () => {
    const owner = randomUUID();
    const count = async () =>
      (await h.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM ledger_accounts')).rows[0]
        ?.n;
    const before = await count();
    const key = {
      entityId: 'aramesh',
      code: 'downpayment.held',
      ownerType: 'borrower' as const,
      ownerId: owner,
    };
    expect(await ledger.findAccount(key)).toBeNull();
    expect(await count()).toBe(before);
    const opened = await ledger.openAccount({ ...key, name: 'held', kind: 'liability' });
    expect(await ledger.findAccount(key)).toEqual({ id: opened.id });
    expect(await count()).toBe((before ?? 0) + 1);
    // Another owner, code or entity is another account.
    expect(await ledger.findAccount({ ...key, ownerId: randomUUID() })).toBeNull();
    expect(await ledger.findAccount({ ...key, code: 'borrower.debt' })).toBeNull();
    expect(await ledger.findAccount({ ...key, entityId: 'sepehr' })).toBeNull();
    // A company account has no owner.
    const company = await ledger.openAccount({
      entityId: 'aramesh',
      code: 'bank.collection',
      name: 'bank',
      kind: 'asset',
      ownerType: 'company',
      ownerId: null,
    });
    expect(
      await ledger.findAccount({
        entityId: 'aramesh',
        code: 'bank.collection',
        ownerType: 'company',
        ownerId: null,
      }),
    ).toEqual({ id: company.id });
  });
});
