import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BULK_IMPORT_SPEC } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { MALWARE_SCANNER } from '../../src/common/security/malware-scanner.port';
import { writeWorkbook } from '../../src/common/xlsx';
import { DATABASE, type Database } from '../../src/db/database.module';
import { BulkImportService } from '../../src/modules/catalog/bulk-import.service';
import { CenterService } from '../../src/modules/catalog/center.service';
import { DoctorService } from '../../src/modules/catalog/doctor.service';
import { OTP_SENDER } from '../../src/modules/identity/otp-login.service';
import { PersonService } from '../../src/modules/lead/person.service';
import { BlindIndex } from '../../src/security/blind-index';
import { councilNumber, nationalId, sheba } from '../catalog/fixtures';
import { CREDIT_HARNESS, creditWorld, type Row } from '../credit/world';
import { newMobile, startHarness, type Harness, type LoggedInAccount } from '../identity/harness';

/**
 * ADR-042 (owner 1405/07/22): persons, doctors and centers are found and kept unique by their
 * blind indexes under every key of the ring. Data is written by the running API under key 1;
 * a second API with key 2 active (the rotation, before re-encryption) must still find it,
 * refuse it twice, and never call the same national ID under another key a different one.
 */
let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let rotated: INestApplication | undefined;
let specialist: LoggedInAccount;

const NID = nationalId();
const DOCTOR_NID = nationalId();
const CENTER_ID = nationalId();
const SHEBA = sheba();
const mobiles = { first: newMobile(), second: newMobile(), bare: newMobile() };
const ids = { person: '', bare: '', activeCenter: '', branch: '' };
const reason = { reason: 'آزمون چرخش کلید' };

const q = async (text: string, values: unknown[] = []) =>
  (await h.owner.query<Row>(text, values)).rows;
const rot = () => rotated as INestApplication;
const accessOf = (who: LoggedInAccount) => rot().get<AccessPort>(ACCESS_PORT).resolve(who.id);
const actorOf = (who: LoggedInAccount) => ({
  accountId: who.id,
  sessionId: null,
  ip: null,
  roles: [],
});
const index1 = () => new BlindIndex(Buffer.from(process.env['BLIND_INDEX_KEY'] ?? '', 'base64'));

/** findOrCreate in its own transaction, in the API given. */
function findOrCreate(
  app: { get: INestApplication['get'] },
  input: { mobile: string; nationalId?: string | null },
) {
  return app
    .get<Database>(DATABASE)
    .transaction((tx) =>
      app.get(PersonService).findOrCreate(tx, CLI_ACTOR, { ...input, addedVia: 'person_created' }),
    );
}

function book(parts: Partial<Record<keyof typeof BULK_IMPORT_SPEC, string[][]>>): Buffer {
  return Buffer.from(
    writeWorkbook(
      (Object.keys(parts) as (keyof typeof BULK_IMPORT_SPEC)[]).map((sheet) => ({
        name: BULK_IMPORT_SPEC[sheet].title,
        rows: [BULK_IMPORT_SPEC[sheet].columns.map((c) => c.title), ...(parts[sheet] ?? [])],
      })),
    ),
  );
}

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  specialist = w.specialist;

  // Under key 1, by the running API: a person with a national ID, one without, a center and
  // a doctor with theirs.
  ids.person = (await findOrCreate(h.app, { mobile: mobiles.first, nationalId: NID })).person.id;
  ids.bare = (await findOrCreate(h.app, { mobile: mobiles.bare })).person.id;
  const center = await w.staff(specialist, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: CENTER_ID,
    name: 'مرکز کلید یک',
    cityCode: 'tehran',
    sheba: SHEBA,
    accountHolderName: 'صاحب حساب',
    treatmentFieldCodes: ['dental'],
  });
  expect(center.status, JSON.stringify(center.body)).toBe(201);
  const [active] = await q(
    `SELECT c.id, b.id AS branch FROM centers c JOIN branches b ON b.center_id = c.id
     WHERE c.status = 'active' AND c.id <> $1 ORDER BY c.created_at LIMIT 1`,
    [center.body['id']],
  );
  ids.activeCenter = active?.['id'] as string;
  ids.branch = active?.['branch'] as string;
  const doctor = await w.staff(specialist, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: 'دکتر کلید یک',
    medicalCouncilNumber: councilNumber(),
    nationalId: DOCTOR_NID,
    workplace: { kind: 'branch', branchId: ids.branch },
    ...reason,
  });
  expect(doctor.status, JSON.stringify(doctor.body)).toBe(201);
  const [stored] = await q('SELECT national_id_index FROM persons WHERE id = $1', [ids.person]);
  expect(stored?.['national_id_index']).toBe(index1().of('national_id', NID));
  await q(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('catalog.bulk_import_enabled', 'global', 'true', now(), 'approved', 'آزمون', now())`,
  );

  // The rotation: key 2 added and active for both secrets; the file scanner says clean.
  Object.assign(process.env, {
    FIELD_ENCRYPTION_KEY_2: randomBytes(32).toString('base64'),
    FIELD_ENCRYPTION_KEY_ACTIVE: '2',
    BLIND_INDEX_KEY_2: randomBytes(32).toString('base64'),
    BLIND_INDEX_KEY_ACTIVE: '2',
  });
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OTP_SENDER)
    .useValue(h.sms)
    .overrideProvider(MALWARE_SCANNER)
    .useValue({ configured: true, scan: () => Promise.resolve({ clean: true }) })
    .compile();
  rotated = ref.createNestApplication();
  await rotated.init();
}, 300_000);

afterAll(async () => {
  await rotated?.close();
  await h.close();
  delete process.env['FIELD_ENCRYPTION_KEY_2'];
  delete process.env['FIELD_ENCRYPTION_KEY_ACTIVE'];
  delete process.env['BLIND_INDEX_KEY_2'];
  delete process.env['BLIND_INDEX_KEY_ACTIVE'];
});

describe('blind indexes under every key during a rotation (ADR-042)', () => {
  it('a person under key 1 is found by national ID: no second person', async () => {
    const before = await q('SELECT count(*)::int AS n FROM persons');
    const found = await findOrCreate(rot(), { mobile: mobiles.second, nationalId: NID });
    expect(found).toMatchObject({ created: false, mobilePending: true });
    expect(found.person.id).toBe(ids.person);
    expect(await q('SELECT count(*)::int AS n FROM persons')).toEqual(before);
  });

  it('the same national ID under key 1 and key 2 is the same: no false conflict', async () => {
    const same = await findOrCreate(rot(), { mobile: mobiles.first, nationalId: NID });
    expect(same.person.id).toBe(ids.person);
    expect(same.nationalIdConflict).toBe(false);
    // A really different national ID is still a conflict.
    const other = await findOrCreate(rot(), { mobile: mobiles.first, nationalId: nationalId() });
    expect(other.nationalIdConflict).toBe(true);
  });

  it('a person without a national ID is not given one another person holds under key 1', async () => {
    const filled = await findOrCreate(rot(), { mobile: mobiles.bare, nationalId: NID });
    expect(filled.person.id).toBe(ids.bare);
    expect(filled.nationalIdConflict).toBe(true);
    const [bare] = await q('SELECT national_id_index FROM persons WHERE id = $1', [ids.bare]);
    expect(bare?.['national_id_index']).toBeNull();
  });

  it('a doctor’s national ID under key 1 is refused to another doctor', async () => {
    await expect(
      rot()
        .get(DoctorService)
        .register(actorOf(specialist), await accessOf(specialist), {
          name: 'دکتر تکراری',
          medicalCouncilNumber: councilNumber(),
          nationalId: DOCTOR_NID,
          workplace: { kind: 'branch', branchId: ids.branch },
          ...reason,
        }),
    ).rejects.toMatchObject({ response: { error: 'duplicate_national_id' } });
  });

  it('a center’s identifier under key 1 is refused to another center', async () => {
    await expect(
      rot()
        .get(CenterService)
        .create(actorOf(specialist), await accessOf(specialist), {
          personType: 'natural',
          identifier: CENTER_ID,
          name: 'مرکز تکراری',
          cityCode: 'tehran',
          treatmentFieldCodes: ['dental'],
        }),
    ).rejects.toMatchObject({ response: { error: 'duplicate_identifier' } });
  });

  it('a center’s Sheba under key 1 is refused: to a new center and as another’s bank account', async () => {
    const access = await accessOf(specialist);
    await expect(
      rot()
        .get(CenterService)
        .create(actorOf(specialist), access, {
          personType: 'natural',
          identifier: nationalId(),
          name: 'مرکز شبای تکراری',
          cityCode: 'tehran',
          sheba: SHEBA,
          accountHolderName: 'صاحب حساب',
          treatmentFieldCodes: ['dental'],
        }),
    ).rejects.toMatchObject({ response: { error: 'duplicate_sheba' } });
    await expect(
      rot()
        .get(CenterService)
        .proposeBankAccount(actorOf(specialist), access, ids.activeCenter, {
          sheba: SHEBA,
          accountHolderName: 'صاحب دیگر',
          ...reason,
        }),
    ).rejects.toMatchObject({ response: { error: 'duplicate_sheba' } });
  });

  it('the bulk import preview sees the center and the doctor under key 1 as registered', async () => {
    const centerRow = (ref: string, id: string) => [
      ref,
      'حقیقی',
      id,
      `مرکز ${ref}`,
      'tehran',
      'نشانی آزمون',
      '',
      '',
      sheba(),
      'صاحب حساب',
      'dental',
    ];
    const file = book({
      centers: [centerRow('C01', CENTER_ID), centerRow('C02', nationalId())],
      doctors: [['D001', 'C02', '', 'دکتر ورودی', councilNumber(), DOCTOR_NID, 'dental']],
    });
    const preview = await rot()
      .get(BulkImportService)
      .upload(actorOf(specialist), await accessOf(specialist), {
        originalname: 'rotation.xlsx',
        size: file.length,
        buffer: file,
      });
    const why = (ref: string) =>
      preview.rejected.find((r) => r.ref === ref)?.problems.map((p) => p.code);
    expect(why('C01')).toEqual(['already_registered']);
    expect(why('D001')).toEqual(['already_registered']);
  });
});
