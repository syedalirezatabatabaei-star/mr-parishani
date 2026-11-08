import { strFromU8, strToU8, Unzip, UnzipInflate, zipSync } from 'fflate';

/**
 * A deliberately small .xlsx reader and writer for the imports (lead, task 2-5b decision 2;
 * centers and doctors, task 2-9),
 * instead of a spreadsheet library: it reads only what the import needs, and only safely.
 *
 * - Only .xlsx: an OLE file (.xls) or a macro-enabled workbook (.xlsm, a VBA project) is
 *   refused, and so is anything that is not a zip.
 * - Against a zip bomb: the number of entries, and the bytes every entry and all of them
 *   together inflate to, are counted while inflating, and the read stops at the limit;
 *   the sizes a zip declares are never trusted.
 * - Values only: a cell's stored value is read as text; a formula is never evaluated (its
 *   cached result, if any, is just another value).
 */

export class XlsxError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface XlsxLimits {
  readonly maxInflatedBytes: number;
  readonly maxZipEntries: number;
  readonly maxRows: number;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const startsWith = (data: Uint8Array, magic: number[]) => magic.every((b, i) => data[i] === b);

/** The parts of a workbook this reader needs, inflated within the limits. */
function unzipParts(data: Uint8Array, limits: XlsxLimits): Map<string, Uint8Array> {
  if (startsWith(data, OLE_MAGIC)) throw new XlsxError('xls_not_supported');
  if (!startsWith(data, ZIP_MAGIC)) throw new XlsxError('not_xlsx');
  const parts = new Map<string, Uint8Array>();
  let entries = 0;
  let total = 0;
  let failure: XlsxError | null = null;
  const unzip = new Unzip((file) => {
    entries++;
    if (entries > limits.maxZipEntries) failure ??= new XlsxError('too_many_entries');
    if (/vbaproject\.bin$/i.test(file.name)) failure ??= new XlsxError('macros_not_allowed');
    const wanted =
      file.name === '[Content_Types].xml' ||
      file.name === 'xl/workbook.xml' ||
      file.name === 'xl/_rels/workbook.xml.rels' ||
      file.name === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(file.name);
    if (!wanted || failure) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = new XlsxError('corrupt_xlsx');
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (total > limits.maxInflatedBytes) {
        failure = new XlsxError('inflated_too_large');
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        parts.set(file.name, out);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(data, true);
  } catch {
    failure ??= new XlsxError('corrupt_xlsx');
  }
  if (failure) throw failure;
  return parts;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** The text of `<t>` runs, phonetic runs (`<rPh>`) left out. */
function textRuns(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) {
    out += decodeXml(m[1] ?? '');
  }
  return out;
}

const attr = (tag: string, name: string) =>
  // nosemgrep: detect-non-literal-regexp -- the pattern is built from code constants, never from user input (no ReDoS)
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Column letters to a zero-based index: A = 0, Z = 25, AA = 26. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A cell's stored value as text; an error cell (`t="e"`) reads as empty. */
function cellValue(
  type: string | null,
  stored: string | undefined,
  body: string,
  shared: readonly string[],
): string {
  if (type === 's') return shared[Number(stored)] ?? '';
  if (type === 'inlineStr') return textRuns(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
  if (type === 'b') return stored === '1' ? 'TRUE' : stored === '0' ? 'FALSE' : '';
  if (type === 'e') return '';
  return decodeXml(stored ?? '');
}

/** A worksheet: its name as the workbook gives it, and its rows of cell texts. */
export interface XlsxSheet {
  readonly name: string;
  readonly rows: string[][];
}

/**
 * Every worksheet, in workbook order, as rows of cell texts; empty rows are dropped.
 * `limits.maxRows` applies to each sheet (plus its header row).
 */
export function readSheets(data: Uint8Array, limits: XlsxLimits): XlsxSheet[] {
  const parts = unzipParts(data, limits);
  const contentTypes = parts.get('[Content_Types].xml');
  if (!contentTypes) throw new XlsxError('not_xlsx');
  const types = strFromU8(contentTypes);
  if (/macroEnabled/i.test(types)) throw new XlsxError('macros_not_allowed');
  if (!types.includes('spreadsheetml.sheet.main+xml')) throw new XlsxError('not_xlsx');

  const workbook = parts.get('xl/workbook.xml');
  const rels = parts.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new XlsxError('not_xlsx');
  const targets = new Map<string, string>();
  for (const m of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) targets.set(id, target);
  }

  const shared: string[] = [];
  const sharedXml = parts.get('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const m of strFromU8(sharedXml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
      shared.push(textRuns(m[1] ?? ''));
    }
  }

  const sheets: XlsxSheet[] = [];
  for (const entry of strFromU8(workbook).matchAll(/<sheet\b[^>]*>/g)) {
    const target = targets.get(attr(entry[0], 'r:id') ?? '');
    if (!target) throw new XlsxError('not_xlsx');
    const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const sheet = parts.get(sheetPath);
    if (!sheet) throw new XlsxError('not_xlsx');
    sheets.push({
      name: decodeXml(attr(entry[0], 'name') ?? ''),
      rows: sheetRows(sheet, shared, limits),
    });
  }
  if (sheets.length === 0) throw new XlsxError('not_xlsx');
  return sheets;
}

/** The first worksheet of the workbook, as rows of cell texts; empty rows are dropped. */
export function readFirstSheet(data: Uint8Array, limits: XlsxLimits): string[][] {
  return readSheets(data, limits)[0]?.rows ?? [];
}

function sheetRows(sheet: Uint8Array, shared: readonly string[], limits: XlsxLimits): string[][] {
  const rows: string[][] = [];
  for (const row of strFromU8(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cell[1] ?? '';
      const body = cell[2] ?? '';
      const ref = attr(head, 'r');
      const type = attr(head, 't');
      const index = ref ? columnIndex(ref) : cells.length;
      const stored = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const value = cellValue(type, stored, body, shared);
      if (index > 200) continue;
      while (cells.length < index) cells.push('');
      cells[index] = value.trim();
    }
    if (cells.some((c) => c !== '')) rows.push(cells);
    if (rows.length > limits.maxRows + 1) throw new XlsxError('too_many_rows');
  }
  return rows;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const columnLetters = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
};

const sheetXml = (rows: readonly (readonly string[])[]) =>
  rows
    .map(
      (cells, r) =>
        // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
        `<row r="${String(r + 1)}">${cells
          .map(
            (v, c) =>
              // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
              `<c r="${columnLetters(c)}${String(r + 1)}" t="inlineStr"><is><t>${escapeXml(v)}</t></is></c>`,
          )
          .join('')}</row>`,
    )
    .join('');

export interface XlsxSheetToWrite {
  /** At most 31 characters, as Excel allows. */
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

/** A workbook of these sheets, every cell an inline string (import templates and reports). */
export function writeWorkbook(sheets: readonly XlsxSheetToWrite[]): Uint8Array {
  const ns = 'http://schemas.openxmlformats.org';
  const overrides = sheets
    .map(
      (_, i) =>
        // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
        `<Override PartName="/xl/worksheets/sheet${String(i + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');
  const entries = sheets
    .map(
      (sheet, i) =>
        // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
        `<sheet name="${escapeXml(sheet.name.slice(0, 31))}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`,
    )
    .join('');
  const relations = sheets
    .map(
      (_, i) =>
        // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
        `<Relationship Id="rId${String(i + 1)}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`,
    )
    .join('');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
    ),
    '_rels/.rels': strToU8(
      // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${entries}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships">${relations}</Relationships>`,
    ),
  };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${String(i + 1)}.xml`] = strToU8(
      // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData>${sheetXml(sheet.rows)}</sheetData></worksheet>`,
    );
  });
  return zipSync(files);
}

/** A workbook of one sheet with these rows as inline strings (the lead import template). */
export function writeSheet(rows: readonly (readonly string[])[]): Uint8Array {
  return writeWorkbook([{ name: 'leads', rows }]);
}
