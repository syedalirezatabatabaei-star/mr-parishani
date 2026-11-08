import * as z from 'zod';
import { jalaliToGregorian } from '../jalali/calendar.js';
import { normalizeBankRef } from './receipts.js';

/**
 * A bank statement imported (task 6-3; doc 15 §2): columns mapped by the person who loads
 * it, each row suggested a slip; nothing is posted and no slip moves (approval is task 6-2's
 * path). Pure: the API parses the file and applies these.
 */

export const AMOUNT_UNITS = ['rial', 'toman'] as const;

export const bankColumnMapSchema = z.strictObject({
  /** Zero-based columns of the sheet. */
  dateColumn: z.int().min(0).max(50),
  amountColumn: z.int().min(0).max(50),
  refColumn: z.int().min(0).max(50).nullable(),
  descriptionColumn: z.int().min(0).max(50).nullable(),
  /** The owner: chosen in the mapping, rials unless said. */
  amountUnit: z.enum(AMOUNT_UNITS).default('rial'),
  /** The first row is the header, not a transaction. */
  headerRow: z.boolean().default(true),
});
export type BankColumnMap = z.output<typeof bankColumnMapSchema>;

const DIGITS: Record<string, string> = {};
'۰۱۲۳۴۵۶۷۸۹'.split('').forEach((d, i) => (DIGITS[d] = String(i)));
'٠١٢٣٤٥٦٧٨٩'.split('').forEach((d, i) => (DIGITS[d] = String(i)));
const latin = (s: string) => s.replace(/[۰-۹٠-٩]/g, (d) => DIGITS[d] ?? d);

/** A statement's amount in rials: Persian or Arabic digits, separators, a unit. */
export function parseStatementAmount(raw: string, unit: 'rial' | 'toman'): bigint | null {
  const plain = latin(raw)
    .replace(/[,،٬\s'’]/g, '')
    .trim();
  if (!/^\d{1,18}$/.test(plain)) return null;
  const value = BigInt(plain);
  if (value <= 0n) return null;
  return unit === 'toman' ? value * 10n : value;
}

/**
 * A statement's day as YYYY-MM-DD (Gregorian, as stored): Jalali (1405/07/14) or Gregorian
 * (2026-10-06), any digit script, / or -; null when it is no day.
 */
export function parseStatementDay(raw: string): string | null {
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/.exec(latin(raw).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (y < 1700) {
    try {
      const g = jalaliToGregorian({ year: y, month: mo, day: d });
      return `${String(g.year)}-${pad(g.month)}-${pad(g.day)}`;
    } catch {
      return null;
    }
  }
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCMonth() !== mo - 1) return null;
  return `${String(y)}-${pad(mo)}-${pad(d)}`;
}

export interface MappedStatementRow {
  readonly rowNo: number;
  readonly paidOn: string | null;
  readonly amountRial: bigint | null;
  readonly bankRef: string | null;
  readonly bankRefNorm: string | null;
  readonly description: string | null;
  /** Why the row cannot be matched: a day or amount that is no day or amount. */
  readonly invalid: 'bad_day' | 'bad_amount' | null;
}

/** The sheet's rows through the mapping; a row that does not fit is kept, marked invalid. */
export function mapStatementRows(
  rows: readonly (readonly string[])[],
  map: BankColumnMap,
): MappedStatementRow[] {
  const body = map.headerRow ? rows.slice(1) : rows;
  const offset = map.headerRow ? 2 : 1;
  return body
    .map((cells, i) => ({ cells, rowNo: i + offset }))
    .filter(({ cells }) => cells.some((c) => c.trim() !== ''))
    .map(({ cells, rowNo }) => {
      const cell = (c: number | null) => (c === null ? null : (cells[c] ?? '').trim() || null);
      const paidOn = parseStatementDay(cell(map.dateColumn) ?? '');
      const amountRial = parseStatementAmount(cell(map.amountColumn) ?? '', map.amountUnit);
      const bankRef = cell(map.refColumn);
      return {
        rowNo,
        paidOn,
        amountRial,
        bankRef,
        bankRefNorm: bankRef ? normalizeBankRef(bankRef) : null,
        description: cell(map.descriptionColumn),
        invalid: paidOn === null ? 'bad_day' : amountRial === null ? 'bad_amount' : null,
      };
    });
}

const BOM = String.fromCharCode(0xfeff);

/** A small CSV reader (RFC 4180: quotes, doubled quotes, CR/LF); a BOM dropped. */
export function readCsv(text: string, maxRows: number): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? '';
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      if (rows.length > maxRows) throw new RangeError('too_many_rows');
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- the API's shapes ---------------------------------------------------------------------

const rial = z.string().regex(/^\d+$/);

export const bankStatementPreviewSchema = z.object({
  headers: z.array(z.string()),
  sampleRows: z.array(z.array(z.string())),
  /** The last mapping used, offered for this file (the owner). */
  suggestedMap: bankColumnMapSchema.nullable(),
  /** With a mapping: its first rows as read, and the sum, before it is confirmed. */
  mapped: z
    .object({
      rows: z.array(
        z.object({
          rowNo: z.int(),
          paidOn: z.string().nullable(),
          amountRial: rial.nullable(),
          bankRef: z.string().nullable(),
          invalid: z.enum(['bad_day', 'bad_amount']).nullable(),
        }),
      ),
      totalRial: rial,
      validRows: z.int(),
      invalidRows: z.int(),
    })
    .nullable(),
});

export const BANK_MATCH_KINDS = ['exact', 'probable', 'none', 'invalid'] as const;

export const bankStatementImportSchema = z.object({
  id: z.uuid(),
  rows: z.int(),
  totalRial: rial,
  matches: z.object({ exact: z.int(), probable: z.int(), none: z.int(), invalid: z.int() }),
  /** The same file again: the import made the first time. */
  replayed: z.boolean(),
});

export const bankStatementRowSchema = z.object({
  id: z.uuid(),
  rowNo: z.int(),
  paidOn: z.string().nullable(),
  amountRial: rial.nullable(),
  bankRef: z.string().nullable(),
  description: z.string().nullable(),
  matchKind: z.enum(BANK_MATCH_KINDS),
  suggestedPaymentId: z.uuid().nullable(),
  /** Task 6-8 (owner ۶): the suggested payment is a cleared cheque's («مربوط به چک»). */
  relatedToCheque: z.boolean(),
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  reviewNote: z.string().nullable(),
});

export const bankStatementRowsQuerySchema = z.object({
  kind: z.enum(BANK_MATCH_KINDS).optional(),
});

export const reviewBankRowSchema = z.strictObject({
  note: z.string().trim().min(3).max(500),
});
