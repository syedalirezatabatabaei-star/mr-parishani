import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatJalaliDate,
  formatJalaliDateTime,
  gregorianToJalali,
  toPersianDigits,
  type MoneyUnit,
} from '@sepehr/contracts';
import type { ReportColumnDefinition } from './report-definition';

/** A cell made ready for a file: what the page shows, before its file's own form. */
export type FileCell = string | number | boolean | null;
export type FileRow = Record<string, FileCell>;

const UNIT_TITLE: Record<MoneyUnit, string> = { rial: 'ریال', toman: 'تومان' };

/** Rials as the chosen unit, exactly: a toman with its tenth when the rials are not whole. */
function money(rial: string, unit: MoneyUnit): string {
  if (unit === 'rial') return rial;
  const r = BigInt(rial);
  const sign = r < 0n ? '-' : '';
  const abs = r < 0n ? -r : r;
  const whole = (abs / 10n).toString();
  return abs % 10n === 0n ? `${sign}${whole}` : `${sign}${whole}.${(abs % 10n).toString()}`;
}

const day = (iso: string, digits: 'fa' | 'latn') => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return formatJalaliDate(gregorianToJalali({ year: y ?? 0, month: m ?? 0, day: d ?? 0 }), {
    digits,
  });
};

/** A column's title in a file: a money column says its unit (doc 17 §5). */
export const fileTitle = (c: ReportColumnDefinition, unit: MoneyUnit) =>
  c.kind === 'rial' ? `${c.title} (${UNIT_TITLE[unit]})` : c.title;

function text(c: ReportColumnDefinition, v: FileCell, unit: MoneyUnit, digits: 'fa' | 'latn') {
  if (v === null) return '';
  if (c.kind === 'bool') return v ? 'بله' : 'خیر';
  if (c.kind === 'rial') return money(String(v), unit);
  if (c.kind === 'date') return day(String(v), digits);
  if (c.kind === 'datetime') return formatJalaliDateTime(new Date(String(v)), { digits });
  if (c.kind === 'int') return String(v);
  return String(v);
}

/** A cell Excel would run as a formula, made text (ر۹); a number is left a number. */
function safe(c: ReportColumnDefinition, value: string): string {
  if ((c.kind === 'int' || c.kind === 'rial') && /^-?\d+(\.\d)?$/.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

/**
 * CSV for Persian Excel (doc 17 §5; test 8): UTF-8 with a BOM, Jalali dates, ASCII digits in
 * the numeric columns, money in the chosen unit with the unit in its header, CRLF.
 */
export function csvOf(
  columns: readonly ReportColumnDefinition[],
  rows: readonly FileRow[],
  unit: MoneyUnit,
): Buffer {
  const lines = [columns.map((c) => quote(fileTitle(c, unit))).join(',')];
  for (const row of rows) {
    lines.push(
      columns.map((c) => quote(safe(c, text(c, row[c.key] ?? null, unit, 'latn')))).join(','),
    );
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join('\r\n')}\r\n`)]);
}

const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

let fontData: string | null = null;

/** The self-hosted font (rules 18–19), as the contract's and the statement's. */
function font(): string {
  if (fontData === null) {
    const file =
      process.env['PDF_FONT_FILE'] ||
      resolve(process.cwd(), '../../packages/ui/fonts/Vazirmatn-Variable.woff2');
    fontData = readFileSync(file).toString('base64');
  }
  return fontData;
}

export interface PdfPage {
  readonly title: string;
  /** The conditions it was run with, as the reader reads them (doc 17 §5). */
  readonly filters: readonly string[];
  readonly columns: readonly ReportColumnDefinition[];
  readonly rows: readonly FileRow[];
  readonly unit: MoneyUnit;
  /** Who and when, on every page (the watermark). */
  readonly who: string;
  readonly at: Date;
}

/**
 * A report's PDF (doc 17 §5): right to left, the self-hosted font, a header, the filters on
 * top, the user's name and the time as a watermark on every page, and page numbers. Nothing
 * outside the document is fetched (rules 17–20).
 */
export function pdfHtml(p: PdfPage): string {
  const when = formatJalaliDateTime(p.at);
  const mark = `${escape(p.who)} — ${when}`;
  // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
  const head = p.columns.map((c) => `<th>${escape(fileTitle(c, p.unit))}</th>`).join('');
  const body = p.rows
    .map(
      (row) =>
        // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
        `<tr>${p.columns
          .map((c) => {
            const shown = text(c, row[c.key] ?? null, p.unit, 'fa');
            // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
            return `<td>${escape(c.kind === 'int' || c.kind === 'rial' ? toPersianDigits(shown) : shown)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  // nosemgrep: html-in-template-string -- each filter escaped
  const filters = p.filters.map((f) => `<li>${escape(f)}</li>`).join('');
  // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<style>
@font-face { font-family: 'Vazirmatn'; src: url(data:font/woff2;base64,${font()}) format('woff2'); }
@page { size: A4 landscape; margin: 14mm 10mm 16mm;
  @bottom-center { content: 'صفحه ' counter(page) ' از ' counter(pages); font-family: 'Vazirmatn'; font-size: 9pt; } }
body { font-family: 'Vazirmatn', sans-serif; font-size: 9pt; color: #1b1b1b; }
h1 { font-size: 14pt; margin: 0 0 4px; }
.meta { color: #555; margin-bottom: 8px; }
.filters { margin: 0 0 8px; padding: 0; list-style: none; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #bbb; padding: 3px 5px; text-align: right; }
th { background: #eee; }
thead { display: table-header-group; }
.watermark { position: fixed; top: 45%; left: 0; right: 0; text-align: center;
  transform: rotate(-24deg); font-size: 28pt; color: rgba(0, 0, 0, 0.07); pointer-events: none; }
</style></head><body>
<div class="watermark">${mark}</div>
<h1>${escape(p.title)}</h1>
<div class="meta">سپهر سلامتی، آرامش ثروت — ${escape(when)} — ${escape(p.who)}</div>
<ul class="filters">${filters}</ul>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`;
}
