import { describe, expect, it } from 'vitest';
import { BULK_IMPORT_SPEC, bulkImportTemplate, parseBulkWorkbook } from './bulk-import.js';

const header = (sheet: keyof typeof BULK_IMPORT_SPEC) =>
  BULK_IMPORT_SPEC[sheet].columns.map((c) => c.title);

/** A valid national ID (checksum), a legal ID and a Sheba for the samples. */
const NATIONAL = '0499370899';
const OTHER_NATIONAL = '0790419904';

function workbook(parts: Partial<Record<keyof typeof BULK_IMPORT_SPEC, string[][]>>) {
  return (Object.keys(parts) as (keyof typeof BULK_IMPORT_SPEC)[]).map((sheet) => ({
    name: BULK_IMPORT_SPEC[sheet].title,
    rows: [header(sheet), ...(parts[sheet] ?? [])],
  }));
}

const center = (ref: string, id = NATIONAL, city = 'tehran') => [
  ref,
  'حقیقی',
  id,
  `مرکز ${ref}`,
  city,
  '',
  '',
  '',
  '',
  '',
  'dental',
];

describe('parseBulkWorkbook (task 2-9)', () => {
  it('reads every sheet with the panel’s own checks, in any digit script', () => {
    const parsed = parseBulkWorkbook(
      workbook({
        centers: [center('c1')],
        branches: [['b1', 'C1', 'شعبه دو', 'نشانی', '۰۲۱۲۲۲۲۲۲۲۲']],
        doctors: [['d1', 'c1', 'b1', 'دكتر علي', '۱۲۳۴۵', '', 'dental']],
        tariffs: [
          ['c1', 'visit', 'خیر', '۵۰۰۰۰۰۰', '8000000'],
          ['d1', 'visit', 'بله', '', ''],
        ],
        schedules: [['d1', 'شنبه', '۰۹:۰۰', '12:00', '30', 'visit']],
      }),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.centers[0]).toMatchObject({
      rowNumber: 2,
      ref: 'C1',
      problems: [],
      value: {
        ref: 'C1',
        center: { personType: 'natural', identifier: NATIONAL, cityCode: 'tehran' },
      },
    });
    expect(parsed.branches[0]?.value).toMatchObject({ phone: '02122222222', center_ref: 'C1' });
    expect(parsed.doctors[0]?.value).toMatchObject({ name: 'دکتر علی', branch_ref: 'B1' });
    expect(parsed.tariffs.map((t) => t.value?.pricing)).toEqual([
      { kind: 'range', minRial: 5_000_000n, maxRial: 8_000_000n },
      { kind: 'free' },
    ]);
    expect(parsed.schedules[0]?.value?.range).toMatchObject({
      weekday: 'saturday',
      start: 540,
      end: 720,
      slotMinutes: 30,
    });
  });

  it('names each problem by its column; references and duplicates are checked in the file', () => {
    const parsed = parseBulkWorkbook(
      workbook({
        centers: [center('c1'), center('c2', NATIONAL), center('c3', '1234567890')],
        doctors: [
          ['d1', 'c1', '', 'دکتر یک', '12345', '', ''],
          ['d2', 'c9', '', 'دکتر دو', '12345', '', ''],
          ['d3', 'c1', 'b9', 'دکتر سه', '12346', OTHER_NATIONAL, ''],
        ],
        tariffs: [['zz', 'visit', 'خیر', '9', '1']],
        schedules: [['d1', 'روزی', '09:00', '12:00', '30', 'visit']],
      }),
    );
    const codes = (rows: { problems: { column: string | null; code: string }[] }[]) =>
      rows.map((r) => r.problems.map((p) => `${p.column ?? '-'}:${p.code}`));
    expect(codes(parsed.centers)).toEqual([
      [],
      ['identifier:duplicate_in_file'],
      ['identifier:invalid_identifier'],
    ]);
    expect(codes(parsed.doctors)).toEqual([
      [],
      ['medical_council_number:duplicate_in_file', 'center_ref:unknown_center'],
      ['branch_ref:unknown_branch'],
    ]);
    expect(codes(parsed.tariffs)).toEqual([['min_rial:price_range']]);
    expect(parsed.schedules[0]?.problems.map((p) => p.column)).toEqual(['weekday']);
  });

  it('requires the centers sheet and the required columns', () => {
    expect(parseBulkWorkbook([]).problems).toEqual([{ sheet: 'centers', code: 'sheet_missing' }]);
    const missing = parseBulkWorkbook([{ name: 'مراکز', rows: [['کد ردیف', 'نام مرکز']] }]);
    expect(missing.problems.map((p) => p.column)).toContain('identifier');
  });

  it('the template has every sheet, titled in Persian, with its header row', () => {
    expect(bulkImportTemplate().map((s) => s.name)).toEqual([
      'مراکز',
      'شعبه‌ها',
      'پزشکان',
      'خدمات و تعرفه‌ها',
      'الگوی تقویم',
    ]);
    expect(parseBulkWorkbook(bulkImportTemplate()).problems).toEqual([]);
  });
});
