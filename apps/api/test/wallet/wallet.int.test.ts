import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import type { PurseScope } from '../../src/common/wallet/wallet.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { createPool } from '../../src/db/pool';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { call, grantRole, loggedInAccount, startHarness, type Harness } from '../identity/harness';

let h: Harness;
let app: Pool;
let wallet: WalletService;
let counter = 0;
const key = (label: string) => `wallet-test-${label}-${String(++counter)}-${String(Date.now())}`;

const M = 1_000_000n; // a million rials

function newScope(): PurseScope {
  return { centerNodeId: randomUUID(), doctorNodeId: randomUUID(), treatmentFieldCode: 'dental' };
}

/** An approved and charged purse. */
async function fundedPurse(amount: bigint, scope = newScope()) {
  const approved = await wallet.approveCredit(CLI_ACTOR, {
    idempotencyKey: key('approve'),
    caseId: randomUUID(),
    borrowerPersonId: randomUUID(),
    amountRial: amount,
    scope,
  });
  await wallet.charge(CLI_ACTOR, approved.purseId, { idempotencyKey: key('charge') });
  return { purseId: approved.purseId, scope };
}

const balances = async (purseId: string) => (await wallet.summary(purseId)).balances;

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
  wallet = h.app.get(WalletService);
});

afterAll(async () => {
  await app.end();
  await h.close();
});

describe('a whole case, on the real ledger (doc 02 §4 as corrected)', () => {
  it('closes: the purse chain returns to zero and the borrower owes exactly what was used', async () => {
    const { purseId, scope } = await fundedPurse(100n * M);
    await wallet.reserve(CLI_ACTOR, purseId, {
      idempotencyKey: key('r'),
      authorizationId: 'auth-1',
      amountRial: 60n * M,
      service: scope,
    });
    await wallet.cancelReservation(CLI_ACTOR, purseId, {
      idempotencyKey: key('c'),
      authorizationId: 'auth-1',
      amountRial: 10n * M,
    });
    await wallet.registerService(CLI_ACTOR, purseId, {
      idempotencyKey: key('s'),
      authorizationId: 'auth-1',
      amountRial: 50n * M,
    });
    const finalized = await wallet.finalize(CLI_ACTOR, purseId, {
      idempotencyKey: key('f'),
      authorizationId: 'auth-1',
      amountRial: 50n * M,
    });
    await wallet.cancelUnused(CLI_ACTOR, purseId, {
      idempotencyKey: key('u'),
      reason: 'انصراف بیمار',
    });

    const summary = await wallet.summary(purseId);
    expect(summary.status).toBe('closed');
    expect(summary.balances).toEqual({
      approvedRial: 0n,
      availableRial: 0n,
      reservedRial: 0n,
      consumedPendingRial: 0n,
      borrowerDebtRial: 50n * M,
    });

    // The doctor is owed exactly the finalized service.
    const journal = await h.app.get(LedgerService).getJournal(finalized.journalEntryId ?? '');
    const payableLine = journal?.lines.find((l) => l.direction === 'credit');
    const payable = await h.app.get(LedgerService).balanceOf(payableLine?.accountId ?? '');
    expect(-payable.netDebitRial).toBe(50n * M);

    // Hard rule: no document of a purse ever touches a bank account (no cash withdrawal).
    const { rows } = await h.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries e
       JOIN journal_entries j ON j.id = e.journal_entry_id
       JOIN ledger_accounts a ON a.id = e.account_id
       WHERE j.event_type LIKE 'wallet.%' AND a.code LIKE 'bank.%'`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('ACCEPTANCE: doc 02 §8 tests 1, 2, 3, 6 and 8', () => {
  it('1. every wallet document balances', async () => {
    const { rows } = await h.owner.query<{ n: number; docs: number }>(`
      SELECT count(*) FILTER (WHERE d <> c)::int AS n, count(*)::int AS docs FROM (
        SELECT e.journal_entry_id,
               sum(e.amount_rial) FILTER (WHERE e.direction = 'debit') AS d,
               sum(e.amount_rial) FILTER (WHERE e.direction = 'credit') AS c
        FROM ledger_entries e JOIN journal_entries j ON j.id = e.journal_entry_id
        WHERE j.event_type LIKE 'wallet.%'
        GROUP BY e.journal_entry_id
      ) t`);
    expect(rows[0]?.docs).toBeGreaterThan(0);
    expect(rows[0]?.n).toBe(0);
  });

  it('2. 50 concurrent withdrawals never take the available balance below zero', async () => {
    const { purseId, scope } = await fundedPurse(100n * M);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        wallet.reserve(CLI_ACTOR, purseId, {
          idempotencyKey: key(`c${String(i)}`),
          authorizationId: `race-${String(i)}`,
          amountRial: 3n * M,
          service: scope,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    // 100 / 3 = 33 fit; the other 17 are refused, not overdrawn.
    expect(ok).toBe(33);
    const b = await balances(purseId);
    expect(b.availableRial).toBe(1n * M);
    expect(b.reservedRial).toBe(99n * M);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toMatchObject({ response: { error: 'insufficient_available' } });
      }
    }
  }, 60_000);

  it('3. a repeated idempotency key creates no second document', async () => {
    const { purseId, scope } = await fundedPurse(10n * M);
    const input = {
      idempotencyKey: key('idem'),
      authorizationId: 'auth-idem',
      amountRial: 2n * M,
      service: scope,
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => wallet.reserve(CLI_ACTOR, purseId, input)),
    );
    expect(new Set(results.map((r) => r.operationId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await balances(purseId)).reservedRial).toBe(2n * M);
    await expect(
      wallet.reserve(CLI_ACTOR, purseId, { ...input, amountRial: 3n * M }),
    ).rejects.toMatchObject({ status: 409, response: { error: 'idempotency_key_reused' } });
  });

  it('6. a connection lost in the middle of registering a service: recoverable, never charged twice', async () => {
    const { purseId, scope } = await fundedPurse(10n * M);
    await wallet.reserve(CLI_ACTOR, purseId, {
      idempotencyKey: key('r6'),
      authorizationId: 'auth-6',
      amountRial: 4n * M,
      service: scope,
    });
    const register = { idempotencyKey: key('s6'), authorizationId: 'auth-6', amountRial: 4n * M };

    // Lost before the commit: nothing happened at all.
    const db = h.app.get<Database>(DATABASE);
    await expect(
      db.transaction(async (tx) => {
        await wallet.registerService(CLI_ACTOR, purseId, register, tx);
        throw new Error('connection lost');
      }),
    ).rejects.toThrow('connection lost');
    expect((await balances(purseId)).consumedPendingRial).toBe(0n);

    // The retry succeeds; lost after the commit, the next retry returns the same result.
    const first = await wallet.registerService(CLI_ACTOR, purseId, register);
    const again = await wallet.registerService(CLI_ACTOR, purseId, register);
    expect(again).toMatchObject({ operationId: first.operationId, replayed: true });
    const b = await balances(purseId);
    expect(b.consumedPendingRial).toBe(4n * M);
    expect(b.reservedRial).toBe(0n);
    expect(b.availableRial).toBe(6n * M);
  });

  it('8. a reversal returns the balances exactly to where they were', async () => {
    const { purseId, scope } = await fundedPurse(10n * M);
    await wallet.reserve(CLI_ACTOR, purseId, {
      idempotencyKey: key('r8'),
      authorizationId: 'auth-8',
      amountRial: 5n * M,
      service: scope,
    });
    const before = await wallet.summary(purseId);
    const registered = await wallet.registerService(CLI_ACTOR, purseId, {
      idempotencyKey: key('s8'),
      authorizationId: 'auth-8',
      amountRial: 3n * M,
    });
    await wallet.reverseOperation(CLI_ACTOR, purseId, registered.operationId, {
      idempotencyKey: key('v8'),
      reason: 'ثبت اشتباه خدمت',
    });
    const after = await wallet.summary(purseId);
    expect(after.balances).toEqual(before.balances);
    expect(after.reservations).toEqual(before.reservations);

    await expect(
      wallet.reverseOperation(CLI_ACTOR, purseId, registered.operationId, {
        idempotencyKey: key('v8b'),
        reason: 'دوباره',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('hard rules (doc 02 §4), in code', () => {
  it('a service only from the center, doctor and treatment field of the case', async () => {
    const { purseId, scope } = await fundedPurse(10n * M);
    for (const service of [
      { ...scope, doctorNodeId: randomUUID() },
      { ...scope, centerNodeId: randomUUID() },
      { ...scope, treatmentFieldCode: 'ophthalmology' },
    ]) {
      await expect(
        wallet.reserve(CLI_ACTOR, purseId, {
          idempotencyKey: key('scope'),
          authorizationId: `scope-${randomUUID()}`,
          amountRial: M,
          service,
        }),
      ).rejects.toMatchObject({ response: { error: 'service_outside_purse_scope' } });
    }
  });

  it('nothing is spent before the charge; the charge happens once, for the whole amount', async () => {
    const scope = newScope();
    const approved = await wallet.approveCredit(CLI_ACTOR, {
      idempotencyKey: key('a'),
      caseId: randomUUID(),
      borrowerPersonId: randomUUID(),
      amountRial: 7n * M,
      scope,
    });
    await expect(
      wallet.reserve(CLI_ACTOR, approved.purseId, {
        idempotencyKey: key('early'),
        authorizationId: 'early',
        amountRial: M,
        service: scope,
      }),
    ).rejects.toMatchObject({ response: { error: 'purse_not_funded' } });
    await wallet.charge(CLI_ACTOR, approved.purseId, { idempotencyKey: key('ch') });
    await expect(
      wallet.charge(CLI_ACTOR, approved.purseId, { idempotencyKey: key('ch2') }),
    ).rejects.toMatchObject({ response: { error: 'already_charged' } });
    const s = await wallet.summary(approved.purseId);
    expect(s.balances.availableRial).toBe(7n * M);
    expect(s.fundedAt).toBeInstanceOf(Date);
  });

  it('a held consumption cannot be finalized until released', async () => {
    const { purseId, scope } = await fundedPurse(10n * M);
    const auth = { authorizationId: 'auth-hold' };
    await wallet.reserve(CLI_ACTOR, purseId, {
      idempotencyKey: key('r'),
      ...auth,
      amountRial: 2n * M,
      service: scope,
    });
    await wallet.registerService(CLI_ACTOR, purseId, {
      idempotencyKey: key('s'),
      ...auth,
      amountRial: 2n * M,
    });
    await wallet.hold(CLI_ACTOR, purseId, {
      idempotencyKey: key('h'),
      ...auth,
      reason: 'شکایت مالی باز',
    });
    await expect(
      wallet.finalize(CLI_ACTOR, purseId, {
        idempotencyKey: key('f'),
        ...auth,
        amountRial: 2n * M,
      }),
    ).rejects.toMatchObject({ status: 409, response: { error: 'consumption_on_hold' } });
    await wallet.release(CLI_ACTOR, purseId, {
      idempotencyKey: key('rl'),
      ...auth,
      reason: 'شکایت رد شد',
    });
    await wallet.finalize(CLI_ACTOR, purseId, {
      idempotencyKey: key('f2'),
      ...auth,
      amountRial: 2n * M,
    });
    expect((await balances(purseId)).consumedPendingRial).toBe(0n);
  });

  it('never more than reserved, pending or available; never a JS number', async () => {
    const { purseId, scope } = await fundedPurse(5n * M);
    const auth = { authorizationId: 'auth-limits' };
    await expect(
      wallet.reserve(CLI_ACTOR, purseId, {
        idempotencyKey: key('big'),
        ...auth,
        amountRial: 6n * M,
        service: scope,
      }),
    ).rejects.toMatchObject({ response: { error: 'insufficient_available' } });
    await wallet.reserve(CLI_ACTOR, purseId, {
      idempotencyKey: key('r'),
      ...auth,
      amountRial: 2n * M,
      service: scope,
    });
    await expect(
      wallet.registerService(CLI_ACTOR, purseId, {
        idempotencyKey: key('s'),
        ...auth,
        amountRial: 3n * M,
      }),
    ).rejects.toMatchObject({ response: { error: 'exceeds_open_reservation' } });
    await expect(
      wallet.finalize(CLI_ACTOR, purseId, { idempotencyKey: key('f'), ...auth, amountRial: M }),
    ).rejects.toMatchObject({ response: { error: 'exceeds_pending_consumption' } });
    await expect(
      wallet.cancelReservation(CLI_ACTOR, purseId, {
        idempotencyKey: key('n'),
        ...auth,
        amountRial: 1000 as unknown as bigint,
      }),
    ).rejects.toMatchObject({ response: { error: 'amount_must_be_bigint_rial' } });
  });

  it('INVARIANT: 400 random operations keep available + reserved + pending + finalized = approved', async () => {
    const amount = 50n * M;
    const { purseId, scope } = await fundedPurse(amount);
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const auths = Array.from({ length: 8 }, (_, i) => `prop-${String(i)}`);
    for (let i = 0; i < 400; i++) {
      const authorizationId = auths[Math.floor(random() * auths.length)] ?? 'prop-0';
      const amountRial = BigInt(1 + Math.floor(random() * 8)) * M;
      const k = key(`p${String(i)}`);
      const pick = Math.floor(random() * 6);
      const ops = [
        () =>
          wallet.reserve(CLI_ACTOR, purseId, {
            idempotencyKey: k,
            authorizationId,
            amountRial,
            service: scope,
          }),
        () =>
          wallet.cancelReservation(CLI_ACTOR, purseId, {
            idempotencyKey: k,
            authorizationId,
            amountRial,
          }),
        () =>
          wallet.registerService(CLI_ACTOR, purseId, {
            idempotencyKey: k,
            authorizationId,
            amountRial,
          }),
        () =>
          wallet.finalize(CLI_ACTOR, purseId, { idempotencyKey: k, authorizationId, amountRial }),
        () =>
          wallet.hold(CLI_ACTOR, purseId, { idempotencyKey: k, authorizationId, reason: 'آزمون' }),
        () =>
          wallet.release(CLI_ACTOR, purseId, {
            idempotencyKey: k,
            authorizationId,
            reason: 'آزمون',
          }),
      ];
      // Many are refused (not enough, not held, …); that is the point: none may break a rule.
      await ops[pick]?.().catch((error: unknown) => {
        const status = (error as { status?: number }).status;
        if (status !== 400 && status !== 404 && status !== 409) throw error;
      });
    }
    const s = await wallet.summary(purseId);
    const finalized = s.reservations.reduce((sum, r) => sum + r.finalizedRial, 0n);
    for (const v of Object.values(s.balances)) expect(v).toBeGreaterThanOrEqual(0n);
    expect(
      s.balances.availableRial +
        s.balances.reservedRial +
        s.balances.consumedPendingRial +
        finalized,
    ).toBe(amount);
    expect(finalized).toBeGreaterThan(0n);
  }, 180_000);
});

describe('the database keeps the purse honest too', () => {
  it('only the state changes, forward only; operations never change', async () => {
    const { purseId } = await fundedPurse(3n * M);
    await expect(
      app.query('UPDATE credit_purses SET approved_amount_rial = 999999999 WHERE id = $1', [
        purseId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query("UPDATE credit_purses SET status = 'approved', funded_at = NULL WHERE id = $1", [
        purseId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(app.query('UPDATE purse_operations SET amount_rial = 1')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(h.owner.query('DELETE FROM purse_operations')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('reading', () => {
  it('accounting reads a purse with amounts as strings; others get 403', async () => {
    const { purseId } = await fundedPurse(9_007_199_254_740_993n);
    const accountant = await loggedInAccount(h, 'staff');
    await grantRole(h, accountant.id, 'accounting');
    const res = await call(h, 'GET', `/wallet/purses/${purseId}`, { bearer: accountant.access });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'funded',
      approvedAmountRial: '9007199254740993',
      balances: { availableRial: '9007199254740993' },
    });
    const nobody = await loggedInAccount(h, 'staff');
    expect(
      (await call(h, 'GET', `/wallet/purses/${purseId}`, { bearer: nobody.access })).status,
    ).toBe(403);
  });
});
