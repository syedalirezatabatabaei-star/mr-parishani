import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BULK_IMPORT_SPEC } from '@sepehr/contracts';
import { writeWorkbook } from '../../src/common/xlsx';
import { BulkImportWorker } from '../../src/modules/catalog/bulk-import-worker';
import { eicar, startScanner, type StartedScanner } from '../support/files';
import { councilNumber, nationalId, sheba } from './fixtures';
import {
  call,
  grantRole,
  loggedInAccount,
  newIp,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * Task 2-9 (doc 08 §12, doc 05 §8, ADR-030): the bulk import of centers and doctors.
 * Acceptance: doc 08 §15 test 9 (an imported center is never active), and a sample of 10
 * centers and 50 doctors with some bad rows gives a right preview and a readable report.
 * Owner decisions: rows of a center wait for its activation; prices only proposed.
 */

let h: Harness;
let scanner: StartedScanner;
let worker: BulkImportWorker;
let specialist: LoggedInAccount;
let otherSpecialist: LoggedInAccount;
let networkManager: LoggedInAccount;
let approver: LoggedInAccount;

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
type Sheet = keyof typeof BULK_IMPORT_SPEC;
const reason = { reason: 'آزمون ورود گروهی' };

const staff = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

function book(parts: Partial<Record<Sheet, string[][]>>): Buffer {
  return Buffer.from(
    writeWorkbook(
      (Object.keys(parts) as Sheet[]).map((sheet) => ({
        name: BULK_IMPORT_SPEC[sheet].title,
        rows: [BULK_IMPORT_SPEC[sheet].columns.map((c) => c.title), ...(parts[sheet] ?? [])],
      })),
    ),
  );
}

async function upload(who: LoggedInAccount, file: Buffer, name = 'centers.xlsx') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)]), name);
  const res = await fetch(`${h.baseUrl}/catalog/imports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.access}`, 'x-forwarded-for': newIp() },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const center = (ref: string, id = nationalId(), city = 'tehran', fields = 'dental') => [
  ref,
  'حقیقی',
  id,
  `مرکز ${ref}`,
  city,
  'نشانی آزمون',
  '',
  '',
  sheba(),
  'صاحب حساب',
  fields,
];

async function rowsOf(batchId: string, sheet: string) {
  const { rows } = await h.owner.query<Row>(
    'SELECT * FROM catalog_import_rows WHERE batch_id = $1 AND sheet = $2 ORDER BY row_number',
    [batchId, sheet],
  );
  return rows;
}

/** Documents, submission and the two-person activation of a center. */
async function activate(centerId: string) {
  const setAll = async (status: string) => {
    const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
    for (const doc of detail.body['documents'] as { code: string }[]) {
      await staff(specialist, 'PUT', `/catalog/centers/${centerId}/documents/${doc.code}`, {
        status,
      });
    }
  };
  await setAll('received');
  expect(
    (await staff(specialist, 'POST', `/catalog/centers/${centerId}/submit`, reason)).status,
  ).toBe(200);
  await setAll('verified');
  const proposed = await staff(
    specialist,
    'POST',
    `/catalog/centers/${centerId}/activation-requests`,
    reason,
  );
  const approved = await staff(
    approver,
    'POST',
    `/catalog/requests/${proposed.body['id'] as string}/approve`,
    {},
  );
  expect(approved.status).toBe(200);
}

async function setFlag(on: boolean) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('catalog.bulk_import_enabled', 'global', $1::jsonb, now(), 'approved', 'آزمون', now())`,
    [JSON.stringify(on)],
  );
}

beforeAll(async () => {
  scanner = await startScanner();
  Object.assign(process.env, scanner.env);
  h = await startHarness();
  worker = h.app.get(BulkImportWorker);
  [specialist, otherSpecialist, networkManager, approver] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, otherSpecialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, networkManager.id, 'network_manager');
  await grantRole(h, approver.id, 'network_manager');
  await staff(networkManager, 'POST', '/catalog/fields', {
    code: 'dental',
    name: 'دندانپزشکی',
    ...reason,
  });
}, 300_000);

afterAll(async () => {
  await h.close();
  await scanner.container.stop();
});

describe('the flag and the file', () => {
  it('is off after the migration; an infected file is refused before it is read', async () => {
    const file = book({ centers: [center('C1')] });
    expect(await upload(specialist, file)).toMatchObject({
      status: 403,
      body: { error: 'feature_disabled' },
    });
    await setFlag(true);
    expect(await upload(specialist, eicar(), 'centers.xlsx')).toMatchObject({
      status: 400,
      body: { error: 'file_infected' },
    });
    expect(await upload(specialist, Buffer.from('a,b\n'), 'centers.xlsx')).toMatchObject({
      status: 400,
      body: { error: 'not_xlsx' },
    });
    const noCenters = book({ doctors: [] });
    expect(await upload(specialist, noCenters)).toMatchObject({
      status: 400,
      body: { error: 'invalid_workbook' },
    });
  });
});

describe('doc 08 §15 test 9 and the sample of 10 centers and 50 doctors', () => {
  let batchId: string;
  let existingCouncil: string;

  it('the preview counts every sheet right and says why each row is left out', async () => {
    // Already registered: a center and a doctor.
    const existingId = nationalId();
    const created = await staff(specialist, 'POST', '/catalog/centers', {
      // Owner 1405/07/27: the registration form requires the contract term.
      contractTerm: { startsOn: '2026-10-01', months: 12 },
      personType: 'natural',
      identifier: existingId,
      name: 'مرکز موجود',
      cityCode: 'tehran',
      sheba: sheba(),
      accountHolderName: 'صاحب حساب',
      treatmentFieldCodes: ['dental'],
    });
    expect(created.status).toBe(201);
    existingCouncil = councilNumber();
    await activate(created.body['id'] as string);
    const detail = await staff(
      specialist,
      'GET',
      `/catalog/centers/${created.body['id'] as string}`,
    );
    const [branch] = detail.body['branches'] as { id: string }[];
    expect(
      (
        await staff(specialist, 'POST', '/catalog/doctors', {
          // Owner 1405/07/27: the registration form requires the contract term.
          contractTerm: { startsOn: '2026-10-01', months: 12 },
          name: 'دکتر موجود',
          medicalCouncilNumber: existingCouncil,
          workplace: { kind: 'branch', branchId: branch?.id },
          ...reason,
        })
      ).status,
    ).toBe(201);

    const centers = Array.from({ length: 10 }, (_, i) =>
      center(`C${String(i + 1).padStart(2, '0')}`),
    );
    centers.push(
      center('C11', '1234567890'), // invalid national ID
      center('C12', nationalId(), 'shiraz'), // outside the uploader's city
      center('C13', existingId), // already registered
      center('C14', nationalId(), 'tehran', 'ortho'), // unknown field
    );
    const doctors: string[][] = [];
    const councils: string[] = [];
    for (let i = 1; i <= 50; i++) {
      const council = councilNumber();
      councils.push(council);
      const centerRef = `C${String(Math.ceil(i / 5)).padStart(2, '0')}`;
      doctors.push([
        `D${String(i).padStart(3, '0')}`,
        centerRef,
        i === 1 ? 'B01' : '',
        `دکتر شماره ${String(i)}`,
        council,
        '',
        'dental',
      ]);
    }
    doctors.push(
      ['D051', 'C01', '', 'دکتر تکراری', councils[0] ?? '', '', ''], // same number twice
      ['D052', 'C11', '', 'دکتر مرکز بد', councilNumber(), '', ''], // its center is rejected
      ['D053', 'C01', '', 'دکتر بی‌شماره', 'abc', '', ''], // invalid number
      ['D054', 'C02', '', 'دکتر ثبت‌شده', existingCouncil, '', ''], // already registered
    );
    const file = book({
      centers,
      branches: [
        ['B01', 'C01', 'شعبه غرب', '', ''],
        ['B02', 'C02', 'شعبه شرق', '', ''],
        ['B99', 'C99', 'شعبه بی‌مرکز', '', ''],
      ],
      doctors,
      tariffs: [
        ['C01', 'visit', 'خیر', '5000000', '8000000'],
        ['D001', 'visit', 'خیر', '6000000', '9000000'],
        ['C01', 'nope', 'خیر', '1000', '2000'],
      ],
      schedules: [
        ['D001', 'شنبه', '09:00', '12:00', '30', 'visit'],
        ['D001', 'یکشنبه', '09:00', '12:00', '30', 'visit'],
        ['D002', 'روزی', '09:00', '12:00', '30', 'visit'],
      ],
    });
    const res = await upload(specialist, file);
    expect(res.status).toBe(201);
    batchId = res.body['batchId'] as string;
    expect(res.body['status']).toBe('previewed');
    expect(res.body['summary']).toEqual({
      centers: { valid: 10, duplicate: 1, error: 3 },
      branches: { valid: 2, duplicate: 0, error: 1 },
      doctors: { valid: 50, duplicate: 1, error: 3 },
      tariffs: { valid: 2, duplicate: 0, error: 1 },
      schedules: { valid: 2, duplicate: 0, error: 1 },
    });
    const rejected = res.body['rejected'] as {
      sheet: string;
      ref: string;
      problems: { code: string }[];
    }[];
    const why = (ref: string) => rejected.find((r) => r.ref === ref)?.problems.map((p) => p.code);
    expect(why('C11')).toEqual(['invalid_identifier']);
    expect(why('C12')).toEqual(['city_out_of_scope']);
    expect(why('C13')).toEqual(['already_registered']);
    expect(why('C14')).toEqual(['unknown_treatment_field']);
    expect(why('B99')).toEqual(['unknown_center']);
    expect(why('D051')).toEqual(['duplicate_in_file']);
    expect(why('D053')).toEqual(['invalid_medical_council_number']);
    expect(why('D054')).toEqual(['already_registered']);

    // Only encrypted identifiers are kept (rule 27); the file is not.
    const [first] = await rowsOf(batchId, 'centers');
    expect(JSON.stringify(first?.['data'])).not.toContain(centers[0]?.[2] ?? 'x');

    // Another specialist does not see this batch.
    expect((await staff(otherSpecialist, 'GET', `/catalog/imports/${batchId}`)).status).toBe(404);
  });

  it('the report is readable: one line per problem, the sheet and column by name', async () => {
    const res = await fetch(`${h.baseUrl}/catalog/imports/${batchId}/report.csv`, {
      headers: { authorization: `Bearer ${specialist.access}`, 'x-forwarded-for': newIp() },
    });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    // A BOM, so Excel shows Persian right (fetch's text() would hide it).
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = (...cells: string[]) => cells.map((c) => `"${c}"`).join(',');
    const lines = bytes.subarray(3).toString('utf8').trim().split('\r\n');
    expect(lines[0]).toBe(csv('برگه', 'ردیف', 'کد ردیف', 'وضعیت', 'ستون', 'مشکل'));
    expect(lines).toContain(
      csv('مراکز', '12', 'C11', 'error', 'کد ملی یا شناسه ملی', 'invalid_identifier'),
    );
    expect(lines).toContain(
      csv('پزشکان', '54', 'D053', 'error', 'شماره نظام پزشکی', 'invalid_medical_council_number'),
    );
    expect(lines).toContain(csv('مراکز', '2', 'C01', 'valid', '', ''));
  });

  it('test 9: committed centers are drafts, never active; their doctors wait', async () => {
    const committed = await staff(specialist, 'POST', `/catalog/imports/${batchId}/commit`, reason);
    expect(committed).toMatchObject({ status: 200, body: { status: 'committed' } });
    const pass = await worker.run();
    expect(pass).toMatchObject({ batchesProcessed: 1, created: 12, applied: 0, proposed: 0 });
    const centerRows = await rowsOf(batchId, 'centers');
    const created = centerRows.filter((r) => r['status'] === 'created');
    expect(created).toHaveLength(10);
    const { rows } = await h.owner.query<Row>(
      'SELECT status, count(*)::int AS n FROM centers WHERE id = ANY($1::uuid[]) GROUP BY status',
      [created.map((r) => r['entity_id'])],
    );
    expect(rows).toEqual([{ status: 'draft', n: 10 }]);
    expect((await rowsOf(batchId, 'doctors')).filter((r) => r['status'] === 'held')).toHaveLength(
      50,
    );
    // Nothing more happens while the centers are drafts.
    expect(await worker.run()).toMatchObject({ batchesProcessed: 0, applied: 0 });
  });

  it('once a center is active its doctors and calendars are applied, its prices proposed', async () => {
    const [c01] = await rowsOf(batchId, 'centers');
    const centerId = c01?.['entity_id'] as string;
    await activate(centerId);
    const pass = await worker.run();
    // 5 doctors and 2 schedule rows; 2 prices proposed.
    expect(pass).toMatchObject({ applied: 7, proposed: 2, failed: 0 });
    const doctorRows = (await rowsOf(batchId, 'doctors')).slice(0, 5);
    expect(doctorRows.map((r) => r['status'])).toEqual(Array(5).fill('applied'));
    const { rows: at } = await h.owner.query<Row>(
      `SELECT b.name FROM doctor_workplaces w JOIN branches b ON b.id = w.branch_id WHERE w.id = $1`,
      [doctorRows[0]?.['entity_id']],
    );
    expect(at[0]?.['name']).toBe('شعبه غرب');
    const calendar = await staff(
      specialist,
      'GET',
      `/booking/workplaces/${doctorRows[0]?.['entity_id'] as string}/calendar`,
    );
    expect((calendar.body['schedule'] as unknown[]).length).toBe(2);

    // The network specialist cannot set prices (task 2-4); the center manager applies them.
    expect(
      (await staff(specialist, 'GET', `/catalog/centers/${centerId}/proposed-tariffs`)).status,
    ).toBe(403);
    const manager = await loggedInAccount(h, 'center');
    const nodeId = (await staff(specialist, 'GET', `/catalog/centers/${centerId}`)).body['nodeId'];
    await grantRole(h, manager.id, 'center_manager', { kind: 'center', nodeId: nodeId as string });
    const proposed = await staff(manager, 'GET', `/catalog/centers/${centerId}/proposed-tariffs`);
    expect(proposed.status).toBe(200);
    expect(proposed.body).toHaveLength(2);
    const applied = await staff(
      manager,
      'POST',
      `/catalog/centers/${centerId}/proposed-tariffs/apply`,
      reason,
    );
    expect(applied.status).toBe(200);
    expect((applied.body as unknown as { status: string }[]).map((r) => r.status)).toEqual([
      'applied',
      'applied',
    ]);
    const { rows: prices } = await h.owner.query<Row>(
      `SELECT t.owner_kind, v.min_amount_rial::text AS min FROM tariffs t
       JOIN tariff_versions v ON v.tariff_id = t.id
       WHERE t.center_id = $1 OR t.workplace_id = $2 ORDER BY t.owner_kind`,
      [centerId, doctorRows[0]?.['entity_id']],
    );
    expect(prices).toEqual([
      { owner_kind: 'center', min: '5000000' },
      { owner_kind: 'workplace', min: '6000000' },
    ]);
    // Applied by the manager, under their name.
    const { rows: audit } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'catalog.tariff_set'
       AND actor_account_id = $1`,
      [manager.id],
    );
    expect(audit[0]?.['n']).toBe(2);
    // A batch something was done with cannot be undone.
    expect(
      (await staff(specialist, 'POST', `/catalog/imports/${batchId}/cancel`, reason)).body,
    ).toMatchObject({ error: 'batch_in_use' });
  });
});

describe('undoing a batch (doc 05 §8)', () => {
  it('while nothing was touched: its centers, branches and tree nodes are retired', async () => {
    const res = await upload(
      specialist,
      book({ centers: [center('X1')], branches: [['XB', 'X1', 'شعبه دوم', '', '']] }),
    );
    const batchId = res.body['batchId'] as string;
    await staff(specialist, 'POST', `/catalog/imports/${batchId}/commit`, reason);
    await worker.run();
    const [row] = await rowsOf(batchId, 'centers');
    const centerId = row?.['entity_id'] as string;
    const cancelled = await staff(specialist, 'POST', `/catalog/imports/${batchId}/cancel`, reason);
    expect(cancelled).toMatchObject({ status: 200, body: { status: 'cancelled' } });
    const { rows } = await h.owner.query<Row>(
      `SELECT c.deleted_at IS NOT NULL AS gone, n.deleted_at IS NOT NULL AS node_gone,
              (SELECT bool_and(b.deleted_at IS NOT NULL) FROM branches b WHERE b.center_id = c.id) AS branches_gone
       FROM centers c JOIN org_nodes n ON n.id = c.node_id WHERE c.id = $1`,
      [centerId],
    );
    expect(rows[0]).toEqual({ gone: true, node_gone: true, branches_gone: true });
    // Rows are never deleted (rule 7).
    expect(await rowsOf(batchId, 'centers')).toHaveLength(1);
    expect((await staff(specialist, 'GET', `/catalog/centers/${centerId}`)).status).toBe(404);
  });

  it('refused once a center of the batch was worked on', async () => {
    const res = await upload(specialist, book({ centers: [center('Y1')] }));
    const batchId = res.body['batchId'] as string;
    await staff(specialist, 'POST', `/catalog/imports/${batchId}/commit`, reason);
    await worker.run();
    const [row] = await rowsOf(batchId, 'centers');
    const centerId = row?.['entity_id'] as string;
    const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
    const [doc] = detail.body['documents'] as { code: string }[];
    await staff(specialist, 'PUT', `/catalog/centers/${centerId}/documents/${doc?.code ?? ''}`, {
      status: 'received',
    });
    const refused = await staff(specialist, 'POST', `/catalog/imports/${batchId}/cancel`, reason);
    expect(refused).toMatchObject({ status: 409, body: { error: 'batch_in_use' } });
  });
});

describe('the batch list (task 2-11): own batches only, filtered and paged on the server', () => {
  it("lists the caller's batches newest first, by status, never another's", async () => {
    await setFlag(true);
    const first = await upload(specialist, book({ centers: [center('L1')] }));
    const second = await upload(specialist, book({ centers: [center('L2')] }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const list = async (who: LoggedInAccount, query = '') => {
      const res = await call(h, 'GET', `/catalog/imports${query}`, { bearer: who.access });
      expect(res.status).toBe(200);
      return res.body as unknown as {
        enabled: boolean;
        total: number;
        items: { batchId: string; status: string }[];
      };
    };
    const mine = await list(specialist, '?status=previewed');
    expect(mine.enabled).toBe(true);
    expect(mine.items.slice(0, 2).map((b) => b.batchId)).toEqual([
      second.body['batchId'],
      first.body['batchId'],
    ]);
    expect(mine.items.every((b) => b.status === 'previewed')).toBe(true);

    const paged = await list(specialist, '?status=previewed&pageSize=1&page=2');
    expect(paged.items.map((b) => b.batchId)).toEqual([first.body['batchId']]);
    expect(paged.total).toBe(mine.total);

    // A batch is its uploader's (ADR-030): another specialist sees none of these.
    const theirs = await list(otherSpecialist);
    expect(theirs.items.map((b) => b.batchId)).not.toContain(first.body['batchId']);
    expect((await list(specialist, '?status=cancelled')).items.map((b) => b.batchId)).not.toContain(
      first.body['batchId'],
    );
  });
});
