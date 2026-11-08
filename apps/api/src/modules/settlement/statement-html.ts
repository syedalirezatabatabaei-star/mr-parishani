import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatJalaliDate,
  formatToman,
  JALALI_MONTH_NAMES,
  toJalali,
  toPersianDigits,
} from '@sepehr/contracts';

/** What a paid statement's PDF shows (task 5-6; doc 06 §5 step 6, §6). */
export interface PrintedStatement {
  readonly doctorName: string;
  readonly periodYear: number;
  readonly periodMonth: number;
  readonly grossRial: bigint;
  readonly creditFeesRial: bigint;
  readonly cashFeesRial: bigint;
  readonly carriedInRial: bigint;
  readonly otherDeductionsRial: bigint;
  readonly payableRial: bigint;
  readonly carriedOutRial: bigint;
  readonly items: readonly {
    kind: 'credit_service' | 'credit_fee' | 'cash_fee';
    occurredAt: Date;
    amountRial: bigint;
  }[];
  readonly payouts: readonly {
    ibanLast4: string;
    paidOn: Date;
    bankTrackingRef: string;
    amountRial: bigint;
  }[];
}

const escape = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

let fontData: string | null = null;

/** The self-hosted font (rules 18–19), as the contract's: PDF_FONT_FILE, else packages/ui. */
function font(): string {
  if (fontData === null) {
    const file =
      process.env['PDF_FONT_FILE'] ||
      resolve(process.cwd(), '../../packages/ui/fonts/Vazirmatn-Variable.woff2');
    fontData = readFileSync(file).toString('base64');
  }
  return fontData;
}

const KIND: Record<PrintedStatement['items'][number]['kind'], string> = {
  credit_service: 'خدمت اعتباری',
  credit_fee: 'کارمزد خدمت اعتباری',
  cash_fee: 'کارمزد خدمت نقدی',
};

/** Tomans (rule 2), a negative one with a minus the reader sees. */
const money = (rial: bigint) => (rial < 0n ? `منفی ${formatToman(-rial)}` : formatToman(rial));
/** Jalali only (rule 21; doc 14 ث): never a Gregorian date in the file. */
const day = (at: Date) => formatJalaliDate(toJalali(at));
/** Digits, dashes and letters of a reference: isolated left to right. */
// nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
const ltr = (text: string) => `<bdi dir="ltr">${escape(text)}</bdi>`;

export function statementHtml(s: PrintedStatement): string {
  const month = `${JALALI_MONTH_NAMES[s.periodMonth - 1] ?? ''} ${toPersianDigits(String(s.periodYear))}`;
  const rows = s.items
    .map(
      (i) =>
        // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
        `<tr><td>${KIND[i.kind]}</td><td>${escape(day(i.occurredAt))}</td><td>${escape(money(i.amountRial))}</td></tr>`,
    )
    .join('');
  const totals: [string, bigint][] = [
    ['جمع خدمات اعتباری', s.grossRial],
    ['کارمزد خدمات اعتباری', s.creditFeesRial],
    ['کارمزد خدمات نقدی', s.cashFeesRial],
    ['مانده منتقل‌شده از دوره قبل', s.carriedInRial],
    ['سایر کسورات', s.otherDeductionsRial],
    ['قابل پرداخت', s.payableRial],
    ['مانده منتقل به دوره بعد', s.carriedOutRial],
  ];
  const payouts = s.payouts.length
    ? // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
      `<h2>پرداخت‌ها</h2><table><thead><tr><th>حساب</th><th>روز پرداخت</th><th>کد رهگیری بانک</th><th>مبلغ</th></tr></thead><tbody>${s.payouts
        .map(
          (p) =>
            // nosemgrep: html-in-template-string -- every interpolated value is escaped (escape/escapeXml) or a constant of this file
            `<tr><td>${ltr(`****${toPersianDigits(p.ibanLast4)}`)}</td><td>${escape(day(p.paidOn))}</td><td>${ltr(p.bankTrackingRef)}</td><td>${escape(money(p.amountRial))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="note">این دوره پرداختی نداشت.</p>';
  // The labels are this file's own; each amount escaped (task 9-3: built before the page so a
  // scanner's note never sits inside the HTML).
  const totalRows = totals
    // nosemgrep: html-in-template-string -- labels are constants above, every value escaped
    .map(([label, v]) => `<tr><th>${label}</th><td>${escape(money(v))}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<title>صورت‌وضعیت ${escape(month)}</title>
<style>
@font-face { font-family: 'Vazirmatn'; src: url(data:font/woff2;base64,${font()}) format('woff2'); font-weight: 100 900; }
html, body { font-family: 'Vazirmatn', sans-serif; direction: rtl; font-size: 11pt; line-height: 1.9; color: #111; }
h1 { font-size: 16pt; text-align: center; margin: 0 0 4pt; }
h2 { font-size: 12.5pt; margin: 14pt 0 4pt; }
.meta { text-align: center; margin-bottom: 10pt; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0; font-variant-numeric: tabular-nums; }
th, td { border: 0.5pt solid #555; padding: 2pt 6pt; text-align: center; }
.note { color: #444; }
</style>
</head>
<body>
<h1>صورت‌وضعیت تسویه پزشک</h1>
<div class="meta">${escape(s.doctorName)} · دوره ${escape(month)} · آرامش ثروت</div>
<h2>جمع‌ها</h2>
<table><tbody>${totalRows}</tbody></table>
<h2>اقلام</h2>
<table><thead><tr><th>نوع</th><th>روز</th><th>مبلغ</th></tr></thead><tbody>${rows}</tbody></table>
${payouts}
</body>
</html>`;
}
