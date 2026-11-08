import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { TOKENS } from './tokens';

/**
 * What each table, view and materialized view holds, in Persian, by its schema-qualified name;
 * partitions are their parent's. Kept beside the code (`apps/api/data-dictionary/tables.json`),
 * not in it: it names every module's tables as documentation, never reading one.
 */
export const TABLES_FILE = join(__dirname, '../../../data-dictionary/tables.json');
/** Columns holding a person's name (names of places, services or roles are not), beside it too. */
export const PERSONAL_NAMES_FILE = join(__dirname, '../../../data-dictionary/personal-names.json');

/**
 * The data dictionary (task 7-6; doc 17 §7): `docs/data-dictionary.md` built from the live
 * schema, each table's line from `tables.json` and each column's from its name's words
 * (`tokens.ts`), with its unit and sensitivity from its name. The same schema gives the same
 * file (no dates in it), so the test compares the committed file with a fresh one.
 */

interface ColumnRow {
  relation: string;
  column: string;
  type: string;
  nullable: boolean;
}

export interface DataDictionary {
  readonly markdown: string;
  /** Relations in the schema with no line in `tables.json`. */
  readonly missingTables: readonly string[];
  /** Lines in `tables.json` for a relation the schema no longer has. */
  readonly staleTables: readonly string[];
  /** Words of column names with no Persian in `tokens.ts`, as `word (table.column)`. */
  readonly missingTokens: readonly string[];
}

/** Columns whose description is a set phrase rather than its words. */
const COMMON: Readonly<Record<string, string>> = {
  id: 'شناسه (UUIDv7)',
  created_at: 'زمان ایجاد',
  updated_at: 'زمان آخرین به‌روزرسانی',
  deleted_at: 'زمان حذف منطقی',
  created_by: 'حساب ایجادکننده',
  deleted_by: 'حساب حذف‌کننده',
};

/** A unit read from the name's last word. */
const UNITS: Readonly<Record<string, string>> = {
  rial: 'ریال',
  bps: 'صدم درصد',
  ms: 'میلی‌ثانیه',
  seconds: 'ثانیه',
  minutes: 'دقیقه',
  hours: 'ساعت',
  days: 'روز',
  bytes: 'بایت',
  e6: 'میلیونیم درجه',
};

const PERSONAL_WORDS = new Set([
  'mobile',
  'national',
  'sheba',
  'iban',
  'address',
  'phone',
  'ip',
  'username',
]);

const words = (column: string): string[] => column.split('_').filter((w) => w.length > 0);

/** Two words read as one phrase. */
const PAIRS: Readonly<Record<string, string>> = {
  national_id: 'کد ملی',
  opted_out: 'لغو اشتراک',
  merged_into: 'ادغام‌شده در',
  free_slot: 'آزاد',
  follow_up: 'پیگیری',
  top_up: 'افزایش',
  down_payment: 'پیش‌پرداخت',
  on_behalf: 'از طرف',
};

/** The words with each known pair joined into one. */
function phrases(list: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const pair = `${list[i] ?? ''}_${list[i + 1] ?? ''}`;
    if (PAIRS[pair] !== undefined) {
      out.push(pair);
      i += 1;
    } else {
      out.push(list[i] ?? '');
    }
  }
  return out;
}

function unitOf(column: string, type: string): string {
  const w = words(column);
  const last = w[w.length - 1] ?? '';
  const unit = UNITS[last];
  if (unit !== undefined) return unit;
  if (type.startsWith('timestamp')) return 'زمان UTC';
  if (type === 'date' || last === 'on' || last === 'day') return 'روز';
  return '';
}

function sensitivityOf(
  personalNames: ReadonlySet<string>,
  relation: string,
  column: string,
): string {
  const w = words(column);
  const last = w[w.length - 1] ?? '';
  const marks: string[] = [];
  if (w.includes('password') || w.includes('secret') || (w.includes('token') && last === 'hash')) {
    marks.push('راز');
  }
  if (last === 'enc' || last === 'encrypted') marks.push('رمزگذاری‌شده');
  const personal =
    w.some((x) => PERSONAL_WORDS.has(x)) || personalNames.has(`${relation}.${column}`);
  if (last === 'bidx' || (last === 'index' && personal)) marks.push('نمایه کور');
  else if (personal) marks.push('شخصی');
  return marks.join('، ');
}

/** A column's Persian: a set phrase, or its words in Persian order with the kind first. */
function describe(column: string): string {
  const common = COMMON[column];
  if (common !== undefined) return common;
  const w = words(column);
  let last = w[w.length - 1];
  // A blind index names what it indexes: national_id_index → «نمایه کور کد ملی».
  let blind = false;
  if (last === 'index' && w.some((x) => PERSONAL_WORDS.has(x))) {
    w.pop();
    blind = true;
    last = w[w.length - 1];
  }
  // The unit and the protection are their own columns.
  if (
    last !== undefined &&
    (UNITS[last] !== undefined || ['enc', 'encrypted', 'bidx'].includes(last))
  ) {
    w.pop();
    last = w[w.length - 1];
  }
  let head = blind ? 'نمایه کور' : '';
  const lastPair = PAIRS[`${w[w.length - 2] ?? ''}_${last ?? ''}`] !== undefined;
  if (
    !blind &&
    !lastPair &&
    (last === 'at' || last === 'id' || last === 'ids' || last === 'by' || last === 'on')
  ) {
    w.pop();
    head = { at: 'زمان', id: 'شناسه', ids: 'شناسه‌های', by: 'حساب', on: 'روز' }[last];
  }
  let lead = '';
  if (w[0] === 'is' || w[0] === 'has') {
    lead = w[0] === 'is' ? 'آیا' : 'دارای';
    w.shift();
  }
  const rest = phrases(w)
    .reverse()
    .map((x) => PAIRS[x] ?? TOKENS[x] ?? x)
    .join(' ');
  return [lead, head, rest].filter((s) => s.length > 0).join(' ') || column;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|');

export async function buildDataDictionary(pool: Pool): Promise<DataDictionary> {
  const TABLES = JSON.parse(readFileSync(TABLES_FILE, 'utf8')) as Readonly<Record<string, string>>;
  const personalNames = new Set(
    JSON.parse(readFileSync(PERSONAL_NAMES_FILE, 'utf8')) as readonly string[],
  );
  const { rows } = await pool.query<ColumnRow>(`
    SELECT n.nspname || '.' || c.relname AS relation, a.attname AS column,
           format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname IN ('public', 'analytics') AND c.relkind IN ('r', 'p', 'v', 'm')
      AND NOT c.relispartition
    ORDER BY 1, a.attnum
  `);
  const relations = new Map<string, ColumnRow[]>();
  for (const r of rows) {
    const list = relations.get(r.relation) ?? [];
    list.push(r);
    relations.set(r.relation, list);
  }
  const names = [...relations.keys()].sort();
  const missingTables = names.filter((n) => TABLES[n] === undefined);
  const staleTables = Object.keys(TABLES)
    .filter((n) => !relations.has(n))
    .sort();
  const missingTokens: string[] = [];

  const lines: string[] = [
    '# فرهنگ داده',
    '',
    '> **تولیدشده؛ دستی ویرایش نشود.** با `pnpm --filter @sepehr/api db:data-dictionary` از',
    '> اسکیمای زنده ساخته می‌شود (تسک ۷-۶؛ سند ۱۷ §۷). توضیح جدول‌ها در',
    '> `apps/api/data-dictionary/tables.json` و واژه‌های نام ستون‌ها در',
    '> `apps/api/src/db/data-dictionary/tokens.ts` است.',
    '>',
    '> - **واحد:** از پسوند نام (`_rial` ریال، `_bps` صدم درصد، `_ms`، `_minutes`، …) یا نوع زمان.',
    '> - **حساسیت:** «راز»، «رمزگذاری‌شده»، «نمایه کور» و «شخصی». نمای `analytics` هیچ ستون شخصی ندارد.',
    '',
    `شمار جدول‌ها و نماها: ${String(names.length)}`,
    '',
  ];
  for (const name of names) {
    lines.push(`## \`${name}\``, '', TABLES[name] ?? '', '');
    lines.push('| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |', '|---|---|---|---|---|---|');
    for (const c of relations.get(name) ?? []) {
      if (COMMON[c.column] === undefined) {
        for (const w of words(c.column)) {
          if (TOKENS[w] === undefined) missingTokens.push(`${w} (${name}.${c.column})`);
        }
      }
      lines.push(
        `| \`${c.column}\` | \`${cell(c.type)}\` | ${c.nullable ? 'بله' : 'خیر'} | ${cell(describe(c.column))} | ${unitOf(c.column, c.type)} | ${sensitivityOf(personalNames, name, c.column)} |`,
      );
    }
    lines.push('');
  }
  return { markdown: lines.join('\n'), missingTables, staleTables, missingTokens };
}
