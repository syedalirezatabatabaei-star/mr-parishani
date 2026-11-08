import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { gregorianDayOf, toJalali } from '@sepehr/contracts';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { DATABASE, type Database } from '../../src/db/database.module';
import { createPool } from '../../src/db/pool';
import { FieldReencryptionService } from '../../src/modules/audit/field-reencryption.service';
import { OTP_SENDER } from '../../src/modules/identity/otp-login.service';
import { INSTRUMENT_NUMBER } from '../../src/modules/instrument/instrument.crypto';
import { InstrumentService } from '../../src/modules/instrument/instrument.service';
import { LedgerReconciliation } from '../../src/modules/ledger/reconciliation';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { ibanContext, PayoutService } from '../../src/modules/settlement/payout.service';
import { SettlementReconciliation } from '../../src/modules/settlement/settlement-reconciliation';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { StatementService } from '../../src/modules/settlement/statement.service';
import { WorkerModule } from '../../src/worker.module';
import { BlindIndex } from '../../src/security/blind-index';
import { FieldCrypto } from '../../src/security/field-crypto';
import { columnReencryptor } from '../../src/security/field-reencryption';
import { keyRingFromEnv } from '../../src/security/key-ring';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';
import {
  call,
  CapturingTextSender,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
} from '../identity/harness';

/**
 * R4 [financial] (owner 1405/07/22; ADR-040; migration 0083): payout orders and instruments
 * under a second key. Real orders (confirmed; failed and issued again) and a real cheque are
 * written by the running API under key 1; a second API with key 2 active simulates the
 * rotation:
 * - while it is under way, the cheque under key 1 is found, and its number is refused again;
 * - the guards let only the owner, inside a running run, rewrite the encrypted columns;
 * - a rewrite that does not read back as it was rolls its batch back, every row in its old form;
 * - a run (two people's approval) rewrites every value under key 2: the same Sheba and number,
 *   the same amounts, statuses and ledger, the same bank file, each row audited without values.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
type World = Awaited<ReturnType<typeof creditWorld>>;

const CHEQUE = '1234567890123456';
const CHEQUE_NEW = '6543210987654321';
const texts = new CapturingTextSender();

let h: Harness;
let app: Pool;
let rotated: INestApplication | undefined;
let worker: INestApplicationContext | undefined;
let manager: Staff;
let finance: Staff;
let finance2: Staff;
let adminA: Staff;
let adminB: Staff;
let completion: Staff;
const ids = {
  confirmed: '',
  failed: '',
  reissued: '',
  batch: '',
  cheque: '',
  delivery: '',
  spareItem: '',
};
const before = {
  csv: '',
  sheba: new Map<string, string>(),
  payouts: [] as Row[],
  instruments: [] as Row[],
  ledger: [] as Row[],
};

const q = async (text: string, values: unknown[] = []) =>
  (await h.owner.query<Row>(text, values)).rows;
const key1 = () =>
  new FieldCrypto(Buffer.from(process.env['FIELD_ENCRYPTION_KEY'] ?? '', 'base64'));
const index1 = () => new BlindIndex(Buffer.from(process.env['BLIND_INDEX_KEY'] ?? '', 'base64'));
const rot = () => rotated as INestApplication;
const tool = () => rot().get(FieldReencryptionService);
const accessOf = (who: Staff) => rot().get<AccessPort>(ACCESS_PORT).resolve(who.id);
const actorOf = (who: Staff) => ({ accountId: who.id, sessionId: null, ip: null, roles: [] });
const fakeBackup = () => ({ take: () => Promise.resolve('sepehr-before-financial-test.dump') });

// --- the payouts' way (as in task 5-5's test) --------------------------------------------

async function setRate(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}
const lastCode = (mobile: string) =>
  /(\d{6})\s*$/.exec([...texts.sent].reverse().find((t) => t.mobile === mobile)?.text ?? '')?.[1] ??
  '';
const today = () => gregorianDayOf(toJalali(new Date()));
const step = (w: World, who: Staff, path: string, body?: unknown) =>
  w.staff(who, 'POST', path, body);

/** A doctor's service final, its month's statement reviewed and approved: one order issued. */
async function approvedStatement() {
  const w = await creditWorld(h);
  const steps = fundingSteps(h, w, { manager, finance });
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
    purseId,
    proformaLineIds: [lines[0]?.['id']],
  });
  await w.staff(w.doctor, 'POST', `/service/authorizations/${made.body['id'] as string}/deliver`, {
    code: lastCode(patient.mobile),
  });
  const { payableId } = await h.app
    .get(SettlementService)
    .accrue(CLI_ACTOR, made.body['id'] as string);
  const [payable] = await q('SELECT doctor_id, due_at FROM doctor_payables WHERE id = $1', [
    payableId,
  ]);
  const dueAt = payable?.['due_at'] as Date;
  await h.app.get(SettlementService).markDue(dueAt);
  const month = toJalali(dueAt);
  const drafted = await h.app
    .get(StatementService)
    .generateFor(CLI_ACTOR, payable?.['doctor_id'] as string, month.year, month.month);
  const statementId = drafted?.statementId as string;
  await step(w, finance, `/settlement/statements/${statementId}/review`);
  expect((await step(w, finance2, `/settlement/statements/${statementId}/approve`)).status).toBe(
    201,
  );
  const orders = (await w.staff(finance, 'GET', `/settlement/payouts?statementId=${statementId}`))
    .body as unknown as Body[];
  expect(orders).toHaveLength(1);
  return { w, applicationId, payoutId: orders[0]?.['id'] as string };
}

async function allow(until: Date) {
  const proposal = await call(h, 'POST', '/config/proposals', {
    bearer: adminA.access,
    body: {
      key: 'audit.field_reencryption',
      scope: { level: 'global' },
      value: { until: until.toISOString() },
      reason: 'بازرمزگذاری جدول‌های مالی با کلید تازه',
    },
  });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  const approved = await call(
    h,
    'POST',
    `/config/proposals/${proposal.body['id'] as string}/approve`,
    { bearer: adminB.access },
  );
  expect(approved.status).toBe(200);
}

/** What a run must never change: every column but the encrypted ones and updated_at. */
const payoutsNow = () =>
  q(`SELECT id, to_jsonb(p) - 'iban_enc' - 'updated_at' AS rest FROM payout_orders p ORDER BY id`);
const instrumentsNow = () =>
  q(`SELECT id, to_jsonb(i) - 'number_enc' - 'number_bidx' - 'updated_at' AS rest
     FROM instruments i ORDER BY id`);
const ledgerNow = () =>
  q(`SELECT (SELECT count(*) FROM journal_entries)::int AS journals,
            (SELECT count(*) FROM ledger_entries)::int AS entries,
            (SELECT coalesce(sum(amount_rial), 0)::text FROM ledger_entries) AS total`);

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  const first = await creditWorld(h);
  manager = await first.role('credit_manager');
  finance = await first.role('accounting');
  finance2 = await first.role('accounting');
  [adminA, adminB] = await Promise.all([loggedInAccount(h, 'staff'), loggedInAccount(h, 'staff')]);
  await grantRole(h, adminA.id, 'system_admin');
  await grantRole(h, adminB.id, 'system_admin');
  app = createPool(h.db.appUrl, 'test-app');
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ relayLoop: false }), {
    logger: false,
  });
  await setRate('settlement.credit_service_fee', { basis: 'percent', bps: 0 });

  // A confirmed order: the bank file, the tracking number by one, confirmed by another.
  const a = await approvedStatement();
  ids.confirmed = a.payoutId;
  completion = a.w.completion;
  const file = await step(a.w, finance, '/settlement/payouts/export', {
    payoutIds: [ids.confirmed],
  });
  ids.batch = file.body['batchId'] as string;
  before.csv = file.body['csv'] as string;
  await step(a.w, finance, `/settlement/payouts/${ids.confirmed}/tracking`, {
    bankTrackingRef: `TRK-${String(Date.now())}`,
    paidOn: today(),
  });
  expect(
    (await step(a.w, finance2, `/settlement/payouts/${ids.confirmed}/confirm`)).body['status'],
  ).toBe('confirmed');

  // A failed order (asked by one, done by another) and the order issued again in its place.
  const b = await approvedStatement();
  ids.failed = b.payoutId;
  for (const who of [finance, finance2]) {
    await step(b.w, who, `/settlement/payouts/${ids.failed}/fail`, { reason: 'شبا اشتباه بود' });
  }
  const again = await step(b.w, finance, `/settlement/payouts/${ids.failed}/reissue`);
  ids.reissued = again.body['id'] as string;
  expect(
    (await q('SELECT status FROM payout_orders ORDER BY id')).map((r) => r['status']).sort(),
  ).toEqual(['confirmed', 'failed', 'issued']);

  // A cheque of the first application, under key 1; a second cheque item kept free.
  const delivery = await a.w.staff(completion, 'POST', '/deliveries', {
    creditApplicationId: a.applicationId,
    items: [
      { kind: 'cheque', label: 'چک وام‌گیرنده' },
      { kind: 'cheque', label: 'چک دوم' },
    ],
  });
  expect(delivery.status, JSON.stringify(delivery.body)).toBe(201);
  ids.delivery = delivery.body['id'] as string;
  await a.w.staff(completion, 'POST', `/deliveries/${ids.delivery}/receive`, {
    method: 'in_person',
  });
  const items = delivery.body['items'] as Body[];
  for (const item of items) {
    await a.w.staff(
      completion,
      'POST',
      `/deliveries/${ids.delivery}/items/${item['id'] as string}`,
      { status: 'received' },
    );
  }
  ids.spareItem = items[1]?.['id'] as string;
  const cheque = await a.w.staff(completion, 'POST', `/deliveries/${ids.delivery}/instruments`, {
    itemId: items[0]?.['id'],
    kind: 'cheque',
    issuer: { role: 'borrower' },
    amountRial: '9600000',
    bankName: 'بانک ملی',
    number: CHEQUE,
  });
  expect(cheque.status, JSON.stringify(cheque.body)).toBe(201);
  ids.cheque = cheque.body['id'] as string;

  const fc = key1();
  for (const r of await q('SELECT id, iban_enc FROM payout_orders')) {
    expect(r['iban_enc']).toMatch(/^v1\./);
    before.sheba.set(
      r['id'] as string,
      fc.decrypt(r['iban_enc'] as string, ibanContext(r['id'] as string)),
    );
  }
  const [stored] = await q('SELECT number_enc, number_bidx FROM instruments WHERE id = $1', [
    ids.cheque,
  ]);
  expect(stored?.['number_bidx']).toBe(index1().of('instrument_number', CHEQUE));

  // The rotation's process: key 2 added and active for both secrets, as the schema owner.
  const appUrl = process.env['DATABASE_URL'];
  process.env['DATABASE_URL'] = h.db.ownerUrl;
  Object.assign(process.env, {
    FIELD_ENCRYPTION_KEY_2: randomBytes(32).toString('base64'),
    FIELD_ENCRYPTION_KEY_ACTIVE: '2',
    BLIND_INDEX_KEY_2: randomBytes(32).toString('base64'),
    BLIND_INDEX_KEY_ACTIVE: '2',
  });
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OTP_SENDER)
    .useValue(h.sms)
    .compile();
  rotated = ref.createNestApplication();
  await rotated.init();
  process.env['DATABASE_URL'] = appUrl;
}, 600_000);

afterAll(async () => {
  await rotated?.close();
  await worker?.close();
  await app.end();
  await h.close();
  delete process.env['FIELD_ENCRYPTION_KEY_2'];
  delete process.env['FIELD_ENCRYPTION_KEY_ACTIVE'];
  delete process.env['BLIND_INDEX_KEY_2'];
  delete process.env['BLIND_INDEX_KEY_ACTIVE'];
});

/** One UPDATE in its own transaction, rolled back: null if allowed, else the error. */
async function attempt(
  pool: Pool,
  runId: string | null,
  table: 'payout_orders' | 'instruments',
  id: string,
  set: string,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (runId !== null) {
      await client.query(`SELECT set_config('sepehr.field_reencryption_run', $1, true)`, [runId]);
    }
    const done = await client.query(`UPDATE ${table} SET ${set} WHERE id = $1`, [id]);
    expect(done.rowCount).toBe(1);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'error';
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function recordedRun(outcome: 'running' | 'completed'): Promise<string> {
  const [run] = await q(
    `INSERT INTO field_reencryption_runs (authorization_version_id, backup_file, outcome, finished_at)
     VALUES ($1, 'test.dump', $2, CASE WHEN $2 = 'running' THEN NULL ELSE now() END)
     RETURNING id`,
    [randomUUID(), outcome],
  );
  return run?.['id'] as string;
}

describe('R4: payout orders and instruments under a second key (ADR-040)', () => {
  it('both tables are registered, and nothing in the database stops a run (0083)', async () => {
    const report = await tool().dryRun();
    expect(report.blockedBy).toEqual([]);
    const of = (t: string) => report.tables.find((x) => x.table === t);
    expect(of('payout_orders')).toMatchObject({ seen: 3, rewritten: 3 });
    expect(of('instruments')).toMatchObject({ seen: 1, rewritten: 1 });
    before.payouts = await payoutsNow();
    before.instruments = await instrumentsNow();
    before.ledger = await ledgerNow();
  });

  it('during the rotation: the cheque under key 1 is found, and its number is refused again', async () => {
    const instruments = rot().get(InstrumentService);
    const access = await accessOf(completion);
    const found = await instruments.search(access, CHEQUE);
    expect(found.map((i) => i.id)).toEqual([ids.cheque]);

    const input = {
      itemId: ids.spareItem,
      kind: 'cheque' as const,
      issuer: { role: 'borrower' as const },
      amountRial: 9_600_000n,
      number: CHEQUE,
    };
    await expect(
      instruments.register(actorOf(completion), access, ids.delivery, input),
    ).rejects.toMatchObject({ response: { error: 'instrument_exists' } });
    expect(await q('SELECT count(*)::int AS n FROM instruments')).toEqual([{ n: 1 }]);
  });

  it('the guards: only the owner, inside a running run, and only the encrypted columns', async () => {
    const running = await recordedRun('running');
    const finished = await recordedRun('completed');
    const sheba = `iban_enc = 'k2.a.b.c'`;
    const number = `number_enc = 'k2.a.b.c', number_bidx = 'k2.test-index'`;
    // Allowed, a confirmed and a failed order too.
    for (const id of [ids.confirmed, ids.failed, ids.reissued]) {
      expect(await attempt(h.owner, running, 'payout_orders', id, sheba)).toBeNull();
    }
    expect(await attempt(h.owner, running, 'instruments', ids.cheque, number)).toBeNull();

    // Refused: no run, a finished run, a run never recorded.
    for (const run of [null, finished, randomUUID()]) {
      expect(await attempt(h.owner, run, 'payout_orders', ids.confirmed, sheba)).toMatch(
        /keeps its statement, center, amount and Sheba/,
      );
      expect(await attempt(h.owner, run, 'instruments', ids.cheque, number)).toMatch(
        /can only change its state/,
      );
    }
    // Refused: anything else changed inside the run.
    for (const set of [
      `${sheba}, amount_rial = amount_rial + 1`,
      `${sheba}, journal_entry_id = NULL`,
      `${sheba}, statement_id = statement_id, center_id = gen_random_uuid()`,
      `${sheba}, failure_reason = 'تغییر'`,
    ]) {
      expect(await attempt(h.owner, running, 'payout_orders', ids.confirmed, set)).not.toBeNull();
    }
    expect(
      await attempt(h.owner, running, 'payout_orders', ids.reissued, `${sheba}, status = 'failed'`),
    ).not.toBeNull();
    for (const set of [`${number}, status = 'verified'`, `${number}, amount_rial = 1`]) {
      expect(await attempt(h.owner, running, 'instruments', ids.cheque, set)).not.toBeNull();
    }
    // The Sheba never in clear, in a run or not (0083, owner س5); both key forms accepted.
    expect(
      await attempt(h.owner, running, 'payout_orders', ids.reissued, `iban_enc = 'IR123'`),
    ).toMatch(/payout_orders_iban_form_check/);
    expect(
      await attempt(
        h.owner,
        running,
        'instruments',
        ids.cheque,
        `number_enc = '1234', number_bidx = 'x'`,
      ),
    ).toMatch(/instruments_values_check/);
    // The application role, even naming the running run: never.
    expect(await attempt(app, running, 'payout_orders', ids.confirmed, sheba)).not.toBeNull();
    expect(await attempt(app, running, 'instruments', ids.cheque, number)).not.toBeNull();
    await q(
      `UPDATE field_reencryption_runs SET outcome = 'failed', finished_at = now()
             WHERE id = $1`,
      [running],
    );
  });

  it('a rewrite that does not read back as it was rolls back: every row keeps key 1', async () => {
    const running = await recordedRun('running');
    const ring = new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY'));
    // Writes another Sheba than the one it read: the check in the run's transaction fails.
    const wrong = {
      get activeKeyId() {
        return ring.activeKeyId;
      },
      decrypt: (stored: string, context: string) => ring.decrypt(stored, context),
      isCurrent: (stored: string) => ring.isCurrent(stored),
      encrypt: (plain: string, context: string) => ring.encrypt(`${plain}0`, context),
    } as unknown as FieldCrypto;
    const broken = columnReencryptor({
      db: rot().get<Database>(DATABASE),
      table: 'payout_orders',
      crypto: wrong,
      columns: [{ column: 'iban_enc', context: (r) => ibanContext(r['id'] as string) }],
    });
    await expect(
      broken.batch({ afterId: null, size: 500, dryRun: false, runId: running }),
    ).rejects.toThrow('re-encryption check failed on payout_orders');
    const fc = key1();
    for (const r of await q('SELECT id, iban_enc FROM payout_orders')) {
      expect(r['iban_enc']).toMatch(/^v1\./);
      expect(fc.decrypt(r['iban_enc'] as string, ibanContext(r['id'] as string))).toBe(
        before.sheba.get(r['id'] as string),
      );
    }
    await q(
      `UPDATE field_reencryption_runs SET outcome = 'failed', finished_at = now()
             WHERE id = $1`,
      [running],
    );
  });

  it('a run: every value under key 2, the same Sheba and number, the books and the bank file unchanged', async () => {
    await allow(new Date(Date.now() + 3_600_000));
    const done = await tool().run(fakeBackup());
    const of = (t: string) => done.tables.find((x) => x.table === t);
    expect(of('payout_orders')).toMatchObject({ rewritten: 3 });
    expect(of('instruments')).toMatchObject({ rewritten: 1 });

    const ring = new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY'));
    const index = new BlindIndex(keyRingFromEnv('BLIND_INDEX_KEY'));
    for (const r of await q('SELECT id, iban_enc FROM payout_orders')) {
      expect(r['iban_enc']).toMatch(/^k2\./);
      expect(ring.decrypt(r['iban_enc'] as string, ibanContext(r['id'] as string))).toBe(
        before.sheba.get(r['id'] as string),
      );
    }
    const [cheque] = await q('SELECT number_enc, number_bidx FROM instruments WHERE id = $1', [
      ids.cheque,
    ]);
    expect(cheque?.['number_enc']).toMatch(/^k2\./);
    expect(ring.decrypt(cheque?.['number_enc'] as string, INSTRUMENT_NUMBER)).toBe(CHEQUE);
    expect(cheque?.['number_bidx']).toBe(index.of('instrument_number', CHEQUE));

    // Nothing else moved: amounts, statuses, statements, ledger documents, the books.
    expect(await payoutsNow()).toEqual(before.payouts);
    expect(await instrumentsNow()).toEqual(before.instruments);
    expect(await ledgerNow()).toEqual(before.ledger);
    const ctx = worker as INestApplicationContext;
    expect(await ctx.get(LedgerReconciliation).run()).toMatchObject({ clean: true });
    expect(await ctx.get(SettlementReconciliation).run()).toMatchObject({ clean: true });

    // The same bank file, read under the new key.
    const file = await rot()
      .get(PayoutService)
      .exported(actorOf(finance), await accessOf(finance), ids.batch);
    expect(file.csv).toBe(before.csv);

    // Found by its number under key 2, and still refused again.
    const instruments = rot().get(InstrumentService);
    const access = await accessOf(completion);
    expect((await instruments.search(access, CHEQUE)).map((i) => i.id)).toEqual([ids.cheque]);
    await expect(
      instruments.register(actorOf(completion), access, ids.delivery, {
        itemId: ids.spareItem,
        kind: 'cheque',
        issuer: { role: 'borrower' },
        amountRial: 9_600_000n,
        number: CHEQUE,
      }),
    ).rejects.toMatchObject({ response: { error: 'instrument_exists' } });

    // Each rewritten row audited in the run: key ids and the run, never a value or ciphertext.
    const shebas = [...before.sheba.values()];
    for (const [action, n] of [
      ['settlement.payout_iban_key_rotated', 3],
      ['instrument.number_key_rotated', 1],
    ] as const) {
      const rows = await q(
        `SELECT before, after, before::text || after::text AS text FROM audit_events
         WHERE action = $1`,
        [action],
      );
      expect(rows, action).toHaveLength(n);
      for (const r of rows) {
        expect(r['after']).toMatchObject({ runId: done.runId });
        expect(r['text']).not.toMatch(/k2\.|v1\./);
        expect(r['text']).not.toContain(CHEQUE);
        for (const s of shebas) expect(r['text']).not.toContain(s);
      }
    }

    // A dry run: nothing left; a new cheque now writes under key 2 beside the old forms.
    const again = await tool().dryRun();
    expect(again.tables.every((t) => t.rewritten === 0)).toBe(true);
    const made = await instruments.register(actorOf(completion), access, ids.delivery, {
      itemId: ids.spareItem,
      kind: 'cheque',
      issuer: { role: 'borrower' },
      amountRial: 9_600_000n,
      number: CHEQUE_NEW,
    });
    const [fresh] = await q('SELECT number_bidx FROM instruments WHERE id = $1', [made.id]);
    expect(fresh?.['number_bidx']).toMatch(/^k2\./);
  });
});
