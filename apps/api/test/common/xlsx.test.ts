import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  readFirstSheet,
  readSheets,
  writeSheet,
  writeWorkbook,
  XlsxError,
} from '../../src/common/xlsx';
import { pickWeighted } from '../../src/modules/lead/round-robin';

const limits = { maxInflatedBytes: 1024 * 1024, maxZipEntries: 50, maxRows: 100 };

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof XlsxError ? error.code : `other: ${String(error)}`;
  }
  return 'no error';
};

/** A workbook whose first sheet is `sheetXml`, with optional extra parts. */
function workbook(sheetXml: string, extra: Record<string, Uint8Array> = {}, macro = false) {
  const ns = 'http://schemas.openxmlformats.org';
  const mainType = macro
    ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  return zipSync({
    '[Content_Types].xml': strToU8(
      // nosemgrep: html-in-template-string -- test fixture markup, never rendered in a browser
      `<Types xmlns="${ns}/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="${mainType}"/></Types>`,
    ),
    'xl/workbook.xml': strToU8(
      // nosemgrep: html-in-template-string -- test fixture markup, never rendered in a browser
      `<workbook xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="a" sheetId="1" r:id="rId7"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId7" Target="worksheets/data.xml"/></Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      `<sst><si><t>موبایل</t></si><si><r><t>09</t></r><r><t xml:space="preserve">12 345 6789</t></r><rPh><t>x</t></rPh></si></sst>`,
    ),
    'xl/worksheets/data.xml': strToU8(sheetXml),
    ...extra,
  });
}

describe('readFirstSheet', () => {
  it('reads shared, inline, numeric and boolean cells, and a formula only as its value', () => {
    const rows = readFirstSheet(
      workbook(
        `<worksheet><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>کد &amp; نام</t></is></c></row>
          <row r="2"/>
          <row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>9121234567</v></c><c r="C3" t="b"><v>1</v></c><c r="D3"><f>HYPERLINK("http://x")</f><v>42</v></c><c r="E3" t="str"><f>1+1</f></c></row>
        </sheetData></worksheet>`,
      ),
      limits,
    );
    expect(rows).toEqual([
      ['موبایل', '', 'کد & نام'],
      ['0912 345 6789', '9121234567', 'TRUE', '42', ''],
    ]);
  });

  it('round-trips the template it writes', () => {
    const data = writeSheet([
      ['موبایل', 'نام'],
      ['=cmd', '<tag> & "q"'],
    ]);
    expect(readFirstSheet(data, limits)).toEqual([
      ['موبایل', 'نام'],
      ['=cmd', '<tag> & "q"'],
    ]);
  });

  it('refuses .xls, .xlsm, a VBA project and anything not a zip', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(codeOf(() => readFirstSheet(ole, limits))).toBe('xls_not_supported');
    expect(codeOf(() => readFirstSheet(strToU8('mobile,name\n'), limits))).toBe('not_xlsx');
    const sheet = '<worksheet><sheetData/></worksheet>';
    expect(codeOf(() => readFirstSheet(workbook(sheet, {}, true), limits))).toBe(
      'macros_not_allowed',
    );
    expect(
      codeOf(() =>
        readFirstSheet(workbook(sheet, { 'xl/vbaProject.bin': new Uint8Array(10) }), limits),
      ),
    ).toBe('macros_not_allowed');
  });

  it('stops a zip bomb while inflating, whatever sizes the zip declares', () => {
    // 20 MB of spaces compresses to a few kilobytes.
    // nosemgrep: html-in-template-string -- test fixture markup, never rendered in a browser
    const bomb = `<worksheet><sheetData>${' '.repeat(20 * 1024 * 1024)}</sheetData></worksheet>`;
    const data = workbook(bomb);
    expect(data.length).toBeLessThan(200_000);
    expect(codeOf(() => readFirstSheet(data, limits))).toBe('inflated_too_large');
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 60; i++) many[`junk/${String(i)}.txt`] = strToU8('x');
    expect(codeOf(() => readFirstSheet(workbook('<worksheet/>', many), limits))).toBe(
      'too_many_entries',
    );
  });

  it('limits the rows', () => {
    const rows = Array.from(
      { length: 150 },
      // nosemgrep: html-in-template-string -- test fixture markup, never rendered in a browser
      (_, i) => `<row r="${String(i + 1)}"><c r="A${String(i + 1)}"><v>${String(i)}</v></c></row>`,
    ).join('');
    expect(
      codeOf(() =>
        // nosemgrep: html-in-template-string -- test fixture markup, never rendered in a browser
        readFirstSheet(workbook(`<worksheet><sheetData>${rows}</sheetData></worksheet>`), limits),
      ),
    ).toBe('too_many_rows');
  });
});

describe('pickWeighted', () => {
  const run = (shares: Record<string, number>, picks: number) => {
    const credit = new Map<string, number>();
    const count = new Map<string, number>();
    for (let i = 0; i < picks; i++) {
      const pick = pickWeighted(
        Object.entries(shares).map(([accountId, percent]) => ({
          accountId,
          percent,
          credit: credit.get(accountId) ?? 0,
        })),
      );
      if (!pick) break;
      for (const [id, value] of pick.credits) credit.set(id, value);
      count.set(pick.accountId, (count.get(pick.accountId) ?? 0) + 1);
    }
    return count;
  };

  it('follows the shares exactly over each cycle, and never picks a zero share', () => {
    const count = run({ a: 50, b: 30, c: 20, z: 0 }, 1000);
    expect(Object.fromEntries(count)).toEqual({ a: 500, b: 300, c: 200 });
    expect(pickWeighted([{ accountId: 'z', percent: 0, credit: 0 }])).toBeNull();
  });

  it('spreads picks instead of bunching them', () => {
    const credit = new Map<string, number>();
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const pick = pickWeighted(
        Object.entries({ a: 50, b: 30, c: 20 }).map(([accountId, percent]) => ({
          accountId,
          percent,
          credit: credit.get(accountId) ?? 0,
        })),
      );
      if (!pick) break;
      for (const [id, value] of pick.credits) credit.set(id, value);
      order.push(pick.accountId);
    }
    expect(order.filter((x) => x === 'a')).toHaveLength(5);
    expect(order.slice(0, 3)).not.toEqual(['a', 'a', 'a']);
  });
});

describe('several sheets (task 2-9)', () => {
  it('reads every sheet in order, by name, each with its own rows', () => {
    const book = writeWorkbook([
      {
        name: 'مراکز',
        rows: [
          ['کد ردیف', 'نام مرکز'],
          ['C1', 'کلینیک <یک> & دو'],
        ],
      },
      { name: 'پزشکان', rows: [['کد ردیف'], ['D1'], ['D2']] },
    ]);
    const sheets = readSheets(book, limits);
    expect(sheets.map((s) => s.name)).toEqual(['مراکز', 'پزشکان']);
    expect(sheets[0]?.rows).toEqual([
      ['کد ردیف', 'نام مرکز'],
      ['C1', 'کلینیک <یک> & دو'],
    ]);
    expect(sheets[1]?.rows).toHaveLength(3);
    // The one-sheet reader of the lead import still reads the first.
    expect(readFirstSheet(book, limits)).toEqual(sheets[0]?.rows);
  });

  it('applies the row limit to each sheet', () => {
    const rows = [['h'], ...Array.from({ length: 5 }, (_, i) => [String(i)])];
    const book = writeWorkbook([
      { name: 'a', rows },
      { name: 'b', rows },
    ]);
    expect(() => readSheets(book, { ...limits, maxRows: 4 })).toThrow('too_many_rows');
    expect(readSheets(book, { ...limits, maxRows: 5 })).toHaveLength(2);
  });
});
