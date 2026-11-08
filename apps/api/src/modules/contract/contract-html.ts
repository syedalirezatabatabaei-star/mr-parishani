import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fillContractTemplate, type ContractTemplate } from '@sepehr/contracts';

/** One installment as the contract shows it: its number, Jalali due day and tomans. */
export interface ShownInstallment {
  readonly index: string;
  readonly dueOn: string;
  readonly amount: string;
}

const escape = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Digits of any script with dashes, slashes and stars only: shown left to right. */
const NUMBER_LIKE = /^[0-9۰-۹٠-٩*/-]+$/;

let fontData: string | null = null;

/**
 * The text font, self-hosted (rules 18–19): PDF_FONT_FILE, else the repository's copy in
 * packages/ui/fonts (the API and worker run from their app folder). Read once.
 */
function font(): string {
  if (fontData === null) {
    const file =
      process.env['PDF_FONT_FILE'] ||
      resolve(process.cwd(), '../../packages/ui/fonts/Vazirmatn-Variable.woff2');
    fontData = readFileSync(file).toString('base64');
  }
  return fontData;
}

/**
 * A contract as a self-contained HTML page (doc 12 §2; task 4-1): the template filled with
 * the contract's values (each escaped), `# ` sections, the installments as a table, right
 * to left, the font inline. A sample template prints «پیش‌نویس — در انتظار تأیید حقوقی» on every
 * page. Nothing in it is fetched.
 */
export function contractHtml(
  template: ContractTemplate,
  values: Readonly<Record<string, string>>,
  installments: readonly ShownInstallment[],
): string {
  // A number-like value (contract number, masked mobile, date) keeps its order inside
  // right-to-left text: isolated left to right, or bidi reverses «۱۴۰۵-۰۰۰۰۰۱».
  const shown = (v: string) =>
    // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
    NUMBER_LIKE.test(v) ? `<bdi dir="ltr">${escape(v)}</bdi>` : escape(v);
  const escaped = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, shown(v)]));
  // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
  const table = `<table><thead><tr><th>قسط</th><th>سررسید</th><th>مبلغ</th></tr></thead><tbody>${installments
    .map(
      (i) =>
        // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
        `<tr><td>${escape(i.index)}</td><td>${escape(i.dueOn)}</td><td>${escape(i.amount)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
  const blocks = template.body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      if (/^\{\{\s*installments\.table\s*\}\}$/.test(block)) return table;
      const heading = block.startsWith('# ');
      const text = fillContractTemplate(escape(heading ? block.slice(2) : block), escaped);
      // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
      return heading ? `<h2>${text}</h2>` : `<p>${text.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  // ADR-035: the rounding is always stated; a template that does not place the note (the
  // ones before it) gets it under its text.
  const note = values['amounts.roundingNote'] ?? '';
  const placed = /\{\{\s*amounts\.roundingNote\s*\}\}/.test(template.body);
  // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
  const roundingNote = note && !placed ? `\n<p class="note">${escape(note)}</p>` : '';
  const sample = template.sample
    ? '<div class="sample">پیش‌نویس — در انتظار تأیید حقوقی</div><div class="watermark">پیش‌نویس — در انتظار تأیید حقوقی</div>'
    : '';
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<title>${escape(template.title)}</title>
<style>
@font-face { font-family: 'Vazirmatn'; src: url(data:font/woff2;base64,${font()}) format('woff2'); font-weight: 100 900; }
html, body { font-family: 'Vazirmatn', sans-serif; direction: rtl; font-size: 11pt; line-height: 1.9; color: #111; }
h1 { font-size: 16pt; text-align: center; margin: 0 0 8pt; }
h2 { font-size: 12.5pt; margin: 14pt 0 4pt; }
p { margin: 0 0 6pt; text-align: justify; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0; font-variant-numeric: tabular-nums; }
th, td { border: 0.5pt solid #555; padding: 2pt 6pt; text-align: center; }
.sample { text-align: center; color: #b00; font-weight: 700; border: 1pt solid #b00; padding: 2pt; margin-bottom: 8pt; }
.watermark { position: fixed; top: 45%; left: 0; right: 0; text-align: center; transform: rotate(-30deg); font-size: 40pt; font-weight: 700; color: rgba(176, 0, 0, 0.08); }
.number { text-align: center; margin-bottom: 10pt; }
</style>
</head>
<body>
${sample}
<h1>${escape(template.title)}</h1>
<div class="number">شماره ${escaped['contract.number'] ?? ''} · تاریخ ${escaped['contract.date'] ?? ''}</div>
${blocks}${roundingNote}
</body>
</html>`;
}
