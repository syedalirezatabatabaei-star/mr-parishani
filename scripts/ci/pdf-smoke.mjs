// Runs inside the worker image (docker-build.sh): a contract printed to PDF with the image's
// own Chromium and font, the code path the worker uses (ADR-033). Made-up values only. Exits
// non-zero when the PDF is missing, not a PDF, or not set in Vazirmatn.
const api = '/app/node_modules/@sepehr/api/dist';
const { contractHtml } = await import(`${api}/modules/contract/contract-html.js`);
const { pdfRendererFromEnv } = await import(`${api}/infra/pdf-renderer.js`);

const template = {
  title: 'قرارداد آزمایشی',
  body: [
    '# قرارداد اعطای اعتبار درمان (نمونه آزمایشی)',
    'وام‌گیرنده: {{borrowerName}}، شماره قرارداد {{contractNumber}}.',
    'مبلغ اعتبار {{amount}} ریال است که در اقساط زیر بازپرداخت می‌شود.',
    '{{installments.table}}',
  ].join('\n\n'),
  sample: true,
  lender: { entityId: 'aramesh_sarvat', name: 'آرامش ثروت' },
};
const html = contractHtml(
  template,
  { borrowerName: 'نمونه آزمایشی', contractNumber: '۱۴۰۵-۰۰۰۰۰۱', amount: '۱۲۰٬۰۰۰٬۰۰۰' },
  [
    { index: '۱', dueOn: '۱۴۰۵/۰۹/۰۱', amount: '۱۰٬۰۰۰٬۰۰۰' },
    { index: '۲', dueOn: '۱۴۰۵/۱۰/۰۱', amount: '۱۰٬۰۰۰٬۰۰۰' },
  ],
);

const renderer = pdfRendererFromEnv();
try {
  const pdf = await renderer.render(html);
  const text = pdf.toString('latin1');
  const problems = [];
  if (!text.startsWith('%PDF-')) problems.push('not a PDF');
  if (pdf.length < 5_000) problems.push(`only ${String(pdf.length)} bytes`);
  if (!/Vazirmatn/.test(text)) problems.push('the Vazirmatn font is not embedded');
  if (problems.length > 0) {
    console.error(`pdf smoke failed: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(`pdf smoke passed: ${String(pdf.length)} bytes, Vazirmatn embedded`);
  }
} finally {
  await renderer.onApplicationShutdown();
}
