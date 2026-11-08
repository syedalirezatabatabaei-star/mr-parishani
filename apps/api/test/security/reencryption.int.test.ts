import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { FieldReencryptionService } from '../../src/modules/audit/field-reencryption.service';
import { OTP_SENDER } from '../../src/modules/identity/otp-login.service';
import { BlindIndex } from '../../src/security/blind-index';
import { FieldCrypto } from '../../src/security/field-crypto';
import { keyRingFromEnv } from '../../src/security/key-ring';
import { nationalId, sheba } from '../catalog/fixtures';
import { CREDIT_HARNESS, creditWorld } from '../credit/world';
import {
  call,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * R4 (task 9-3; owner 1405/07/18): the field re-encryption tool. Data written under key 1 by
 * the running API; a second API with key 2 active runs the tool: by two people's approval
 * only, once per approval, a backup first, audited; every value then under key 2 and
 * readable, every blind index rebuilt. The financial tables (payout orders, instruments) are
 * registered too since R4's financial plan (ADR-040); their own test is
 * financial-reencryption.int.test.ts.
 */
type Row = Record<string, unknown>;

const PINNED = ['lead_import_rows.lead_import_rows_pinned_v1_test'];
const NON_FINANCIAL = [
  'catalog_import_rows',
  'center_change_requests',
  'centers',
  'doctors',
  'lead_import_rows',
  'persons',
  'user_accounts',
];
const REGISTERED = [...NON_FINANCIAL, 'instruments', 'payout_orders'].sort((a, b) =>
  a.localeCompare(b),
);

let h: Harness;
let rotated: INestApplication | undefined;
let adminA: LoggedInAccount;
let adminB: LoggedInAccount;
let staff: LoggedInAccount;
const key1 = () =>
  new FieldCrypto(Buffer.from(process.env['FIELD_ENCRYPTION_KEY'] ?? '', 'base64'));
const index1 = () => new BlindIndex(Buffer.from(process.env['BLIND_INDEX_KEY'] ?? '', 'base64'));
const q = async (text: string, values: unknown[] = []) =>
  (await h.owner.query<Row>(text, values)).rows;
const tool = () => (rotated as INestApplication).get(FieldReencryptionService);
const fakeBackup = (file = 'test-backup.dump') => ({ take: () => Promise.resolve(file) });
const ids = { person: '', leadRow: '', catalogRow: '', request: '', doctor: '', center: '' };
const plain = {
  person: nationalId(),
  doctor: nationalId(),
  importNid: nationalId(),
  sheba: sheba(),
};

async function allow(until: Date) {
  const proposal = await call(h, 'POST', '/config/proposals', {
    bearer: adminA.access,
    body: {
      key: 'audit.field_reencryption',
      scope: { level: 'global' },
      value: { until: until.toISOString() },
      reason: 'بازرمزگذاری با کلید تازه',
    },
  });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  // One person alone cannot allow it: a sensitive key.
  const self = await call(h, 'POST', `/config/proposals/${proposal.body['id'] as string}/approve`, {
    bearer: adminA.access,
  });
  expect(self.status).toBe(403);
  const approved = await call(
    h,
    'POST',
    `/config/proposals/${proposal.body['id'] as string}/approve`,
    { bearer: adminB.access },
  );
  expect(approved.status).toBe(200);
}

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  await creditWorld(h);
  [adminA, adminB, staff] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, adminA.id, 'system_admin');
  await grantRole(h, adminB.id, 'system_admin');

  // Encrypted rows of every registered table, under key 1, as the running API writes them.
  const fc = key1();
  const bi = index1();
  const [center] = await q('SELECT id, node_id FROM centers ORDER BY created_at LIMIT 1');
  ids.center = center?.['id'] as string;
  const centerNode = center?.['node_id'] as string;
  const [doctor] = await q('SELECT id FROM doctors ORDER BY created_at LIMIT 1');
  ids.doctor = doctor?.['id'] as string;
  await q(
    `UPDATE doctors SET national_id_enc = $1, national_id_index = $2, national_id_last4 = $3
     WHERE id = $4`,
    [
      fc.encrypt(plain.doctor, 'doctors.national_id'),
      bi.of('national_id', plain.doctor),
      plain.doctor.slice(-4),
      ids.doctor,
    ],
  );
  ids.request = (
    await q(
      `INSERT INTO center_change_requests (center_id, kind, sheba_enc, sheba_index, sheba_last4,
         account_holder_name, reason, proposed_by)
       VALUES ($1, 'bank_account', $2, $3, $4, 'مریم آزمون', 'تغییر حساب', $5) RETURNING id`,
      [
        ids.center,
        fc.encrypt(plain.sheba, `centers.sheba:${centerNode}`),
        bi.of('sheba', plain.sheba),
        plain.sheba.slice(-4),
        adminA.id,
      ],
    )
  )[0]?.['id'] as string;
  ids.person = (
    await q(
      `INSERT INTO persons (national_id_enc, national_id_index, national_id_last4)
       VALUES ($1, $2, $3) RETURNING id`,
      [
        fc.encrypt(plain.person, 'persons.national_id'),
        bi.of('national_id', plain.person),
        plain.person.slice(-4),
      ],
    )
  )[0]?.['id'] as string;
  const leadBatch = (
    await q(
      `INSERT INTO lead_import_batches (status, file_name, row_count, valid_count, error_count)
       VALUES ('previewed', 'leads.xlsx', 1, 1, 0) RETURNING id`,
    )
  )[0]?.['id'] as string;
  ids.leadRow = (
    await q(
      `INSERT INTO lead_import_rows (batch_id, row_number, status, errors, national_id_enc)
       VALUES ($1, 2, 'valid', '{}', $2) RETURNING id`,
      [leadBatch, fc.encrypt(plain.importNid, 'lead_import_rows.national_id')],
    )
  )[0]?.['id'] as string;
  const catalogBatch = (
    await q(
      `INSERT INTO catalog_import_batches (status, created_by, summary)
       VALUES ('previewed', $1, '{}') RETURNING id`,
      [adminA.id],
    )
  )[0]?.['id'] as string;
  const enc = (field: string, value: string) =>
    fc.encrypt(value, `catalog_import_rows.${field}.${catalogBatch}.doctors.3`);
  ids.catalogRow = (
    await q(
      `INSERT INTO catalog_import_rows (batch_id, sheet, row_number, status, problems, data)
       VALUES ($1, 'doctors', 3, 'valid', '[]', $2) RETURNING id`,
      [
        catalogBatch,
        JSON.stringify({
          name: 'دکتر آزمون',
          nationalId: { enc: enc('national_id', plain.importNid), last4: '0000' },
        }),
      ],
    )
  )[0]?.['id'] as string;

  // The tool's process: key 2 added and made active for both secrets, connected as the schema
  // owner as the CLI is (the application role has no right to rewrite these columns).
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
}, 240_000);

afterAll(async () => {
  await rotated?.close();
  await h.close();
  delete process.env['FIELD_ENCRYPTION_KEY_2'];
  delete process.env['FIELD_ENCRYPTION_KEY_ACTIVE'];
  delete process.env['BLIND_INDEX_KEY_2'];
  delete process.env['BLIND_INDEX_KEY_ACTIVE'];
});

describe('the field re-encryption tool (R4)', () => {
  it('covers all nine tables with an encrypted field: seven non-financial, payouts and instruments (ADR-040)', async () => {
    const report = await tool().dryRun();
    expect(REGISTERED).toHaveLength(9);
    expect(report.tables.map((t) => t.table)).toEqual(REGISTERED);
  });

  it('a dry run counts what a run would rewrite, writes nothing, and is audited', async () => {
    const before = await q('SELECT national_id_enc FROM persons WHERE id = $1', [ids.person]);
    const report = await tool().dryRun();
    for (const table of NON_FINANCIAL) {
      expect(report.tables.find((t) => t.table === table)?.rewritten, table).toBeGreaterThan(0);
    }
    expect(await q('SELECT national_id_enc FROM persons WHERE id = $1', [ids.person])).toEqual(
      before,
    );
    const audited = await q(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'audit.field_reencryption_dry_run'`,
    );
    expect(audited[0]?.['n']).toBeGreaterThan(0);
  });

  it('never runs without two people’s approval still in time', async () => {
    await expect(tool().run(fakeBackup())).rejects.toMatchObject({
      response: { error: 'reencryption_not_authorized' },
    });
    // Approved, but expired by the time of the run.
    await allow(new Date(Date.now() + 60_000));
    await expect(
      tool().run(fakeBackup(), undefined, new Date(Date.now() + 120_000)),
    ).rejects.toMatchObject({ response: { error: 'reencryption_not_authorized' } });
    expect(await q('SELECT count(*)::int AS n FROM field_reencryption_runs')).toEqual([{ n: 0 }]);
  });

  it('does not start while a constraint accepts key 1 only, and keeps the approval', async () => {
    await allow(new Date(Date.now() + 3_600_000));
    // Migration 0079 widened the six; a constraint pinned to key 1's form, as they were.
    expect((await tool().dryRun()).blockedBy).toEqual([]);
    await h.owner.query(
      `ALTER TABLE lead_import_rows ADD CONSTRAINT lead_import_rows_pinned_v1_test
         CHECK (national_id_enc IS NULL OR national_id_enc LIKE 'v1.%')`,
    );
    try {
      expect((await tool().dryRun()).blockedBy).toEqual(PINNED);
      await expect(tool().run(fakeBackup())).rejects.toMatchObject({
        response: { error: 'database_constraints_pin_key_1', blockedBy: PINNED },
      });
      expect(await q('SELECT count(*)::int AS n FROM field_reencryption_runs')).toEqual([{ n: 0 }]);
    } finally {
      await h.owner.query(
        'ALTER TABLE lead_import_rows DROP CONSTRAINT lead_import_rows_pinned_v1_test',
      );
    }
    expect((await tool().dryRun()).blockedBy).toEqual([]);
  });

  it('writes nothing when the backup fails, and keeps the approval for a later run', async () => {
    const failing = { take: () => Promise.reject(new Error('pg_dump exited with 1')) };
    await expect(tool().run(failing)).rejects.toThrow('pg_dump');
    expect(await q('SELECT count(*)::int AS n FROM field_reencryption_runs')).toEqual([{ n: 0 }]);
    const [person] = await q('SELECT national_id_enc FROM persons WHERE id = $1', [ids.person]);
    expect(person?.['national_id_enc']).toMatch(/^v1\./);
  });

  it('runs once per approval: every value under key 2, readable, indexes rebuilt, audited', async () => {
    const done = await tool().run(fakeBackup('sepehr-before-reencrypt-test.dump'));
    expect(done.backupFile).toBe('sepehr-before-reencrypt-test.dump');
    const ring = new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY'));
    const index = new BlindIndex(keyRingFromEnv('BLIND_INDEX_KEY'));

    const [person] = await q(
      'SELECT national_id_enc, national_id_index FROM persons WHERE id = $1',
      [ids.person],
    );
    expect(person?.['national_id_enc']).toMatch(/^k2\./);
    expect(ring.decrypt(person?.['national_id_enc'] as string, 'persons.national_id')).toBe(
      plain.person,
    );
    expect(person?.['national_id_index']).toBe(index.of('national_id', plain.person));

    const [doctor] = await q(
      'SELECT national_id_enc, national_id_index FROM doctors WHERE id = $1',
      [ids.doctor],
    );
    expect(ring.decrypt(doctor?.['national_id_enc'] as string, 'doctors.national_id')).toBe(
      plain.doctor,
    );
    expect(doctor?.['national_id_index']).toBe(index.of('national_id', plain.doctor));

    const [request] = await q(
      `SELECT r.sheba_enc, r.sheba_index, c.node_id FROM center_change_requests r
       JOIN centers c ON c.id = r.center_id WHERE r.id = $1`,
      [ids.request],
    );
    expect(
      ring.decrypt(
        request?.['sheba_enc'] as string,
        `centers.sheba:${request?.['node_id'] as string}`,
      ),
    ).toBe(plain.sheba);
    expect(request?.['sheba_index']).toBe(index.of('sheba', plain.sheba));

    const [lead] = await q('SELECT national_id_enc FROM lead_import_rows WHERE id = $1', [
      ids.leadRow,
    ]);
    expect(ring.decrypt(lead?.['national_id_enc'] as string, 'lead_import_rows.national_id')).toBe(
      plain.importNid,
    );
    const [imported] = await q('SELECT batch_id, data FROM catalog_import_rows WHERE id = $1', [
      ids.catalogRow,
    ]);
    const data = imported?.['data'] as { name: string; nationalId: { enc: string; last4: string } };
    expect(data.name).toBe('دکتر آزمون');
    expect(data.nationalId.last4).toBe('0000');
    expect(
      ring.decrypt(
        data.nationalId.enc,
        `catalog_import_rows.national_id.${imported?.['batch_id'] as string}.doctors.3`,
      ),
    ).toBe(plain.importNid);

    // Every encrypted value and index of these tables is now under key 2.
    const left = await q(`
      SELECT
        (SELECT count(*) FROM centers WHERE identifier_enc NOT LIKE 'k2.%'
           OR identifier_index NOT LIKE 'k2.%' OR sheba_enc NOT LIKE 'k2.%'
           OR sheba_index NOT LIKE 'k2.%')::int AS centers,
        (SELECT count(*) FROM user_accounts WHERE totp_secret_encrypted NOT LIKE 'k2.%')::int AS totp,
        (SELECT count(*) FROM persons WHERE national_id_enc NOT LIKE 'k2.%')::int AS persons`);
    expect(left).toEqual([{ centers: 0, totp: 0, persons: 0 }]);

    // The staff's TOTP secret reads back under key 2, bound to its own account.
    const [account] = await q('SELECT totp_secret_encrypted FROM user_accounts WHERE id = $1', [
      staff.id,
    ]);
    expect(account?.['totp_secret_encrypted']).toMatch(/^k2\./);
    expect(
      ring.decrypt(
        account?.['totp_secret_encrypted'] as string,
        `user_accounts.totp_secret_encrypted:${staff.id}`,
      ),
    ).toMatch(/^[A-Z2-7]+=*$/);

    // Every center whose identity or Sheba index was rebuilt is audited, in the run's own
    // transaction: the key ids and the run, never a value.
    const rotated = await q(
      `SELECT entity_id, before, after, after::text AS text FROM audit_events
       WHERE action = 'catalog.center_keys_rotated'`,
    );
    expect(rotated).toHaveLength(done.tables.find((t) => t.table === 'centers')?.rewritten ?? -1);
    expect(rotated.map((r) => r['entity_id'])).toContain(ids.center);
    for (const r of rotated) {
      expect(r['before']).toMatchObject({ identifierKey: 1 });
      expect(r['after']).toMatchObject({ runId: done.runId, identifierKey: 2 });
      expect(r['text']).not.toMatch(/k2\.|v1\./);
    }

    const [run] = await q('SELECT outcome, backup_file, counts FROM field_reencryption_runs');
    expect(run).toMatchObject({ outcome: 'completed', backup_file: done.backupFile });
    const actions = (
      await q(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY seq`, [done.runId])
    ).map((r) => r['action']);
    expect(actions).toEqual([
      'audit.field_reencryption_started',
      'audit.field_reencryption_completed',
    ]);
    // Counts only: no value, plain or encrypted, in the audit record.
    const [completed] = await q(
      `SELECT after::text AS after FROM audit_events
       WHERE entity_id = $1 AND action = 'audit.field_reencryption_completed'`,
      [done.runId],
    );
    expect(completed?.['after']).not.toContain(plain.person);
    expect(completed?.['after']).not.toContain('k2.');

    // The same approval does not allow a second run.
    await expect(tool().run(fakeBackup())).rejects.toMatchObject({
      response: { error: 'authorization_used' },
    });
    // A second dry run: nothing left to rewrite.
    const again = await tool().dryRun();
    expect(again.tables.every((t) => t.rewritten === 0)).toBe(true);
  });
});
