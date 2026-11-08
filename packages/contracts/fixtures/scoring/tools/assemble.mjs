// Builds golden-v1.json from the case list (cases.json) and what Excel computed for each
// case in the client's workbook (excel-results.json). Task 3-1; doc 03 §9.
//
//   node tools/cases.mjs > tools/cases.json
//   powershell -NoProfile -File tools/evaluate-in-excel.ps1
//   node tools/assemble.mjs
//
// Every expected value is copied from Excel's result; nothing is computed here.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const read = (file) => JSON.parse(readFileSync(resolve(here, file), 'utf8').replace(/^\uFEFF/, ''));
const spec = read('cases.json');
const excel = read('excel-results.json');

const sourceDir = resolve(here, '../../../../../docs/source');
const workbook = readdirSync(sourceDir).find((f) => f.endsWith('.xlsx'));
const sha256 = createHash('sha256')
  .update(readFileSync(resolve(sourceDir, workbook)))
  .digest('hex');

/** Each named output and the cell of «فرم ارزیابی» it is read from. */
const OUTPUTS = {
  amountLevel: 'E7',
  borrower: {
    scores: { job: 'D10', tenure: 'D11', coverage: 'D12', obligations: 'D13' },
    total: 'B17',
    stop: 'B18',
    grade: 'D17',
    interpretation: 'D18',
  },
  guarantor1: {
    scores: { job: 'I10', tenure: 'I11', coverage: 'I12', debts: 'I13', independence: 'I14' },
    total: 'G17',
    grade: 'G18',
    stop: 'G19',
    weight: 'O17',
  },
  guarantor2: {
    scores: { job: 'N10', tenure: 'N11', coverage: 'N12', debts: 'N13', independence: 'N14' },
    total: 'L17',
    grade: 'L18',
    stop: 'L19',
    weight: 'O18',
  },
  requiredGuarantee: 'B19',
  sufficiency: 'B26',
  decisionAuthority: 'B27',
};

// An empty cell («""» in a formula) is null; numbers and texts are Excel's own.
const value = (v) => (v === '' || v === undefined ? null : v);
const pick = (shape, cells) =>
  typeof shape === 'string'
    ? value(cells[shape])
    : Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, pick(s, cells)]));

const options = Object.fromEntries(
  Object.entries(spec.options).map(([who, criteria]) => [
    who,
    Object.fromEntries(
      Object.entries(criteria).map(([criterion, list]) => [
        criterion,
        list.map(({ code, cell }) => ({
          code,
          cell: `جداول پایه!${cell}`,
          label: excel.labels[cell],
          score: excel.scores[cell],
        })),
      ]),
    ),
  ]),
);

const cases = spec.cases.map((c) => {
  const cells = excel.results[c.id];
  if (!cells) throw new Error(`Excel has no result for ${c.id}`);
  const { amountToman, approvedToman, ...rest } = c.inputs;
  return {
    id: c.id,
    title: c.title,
    covers: c.covers,
    excelBug: c.excelBug,
    inputs: {
      amountToman,
      amountRial: amountToman === null ? null : String(BigInt(amountToman) * 10n),
      approvedToman,
      ...rest,
    },
    expected: pick(OUTPUTS, cells),
  };
});

const golden = {
  about: [
    'Golden cases of the credit scoring engine (doc 03 §9, task 3-1).',
    'Every «expected» value was computed by Microsoft Excel from the client workbook named in',
    '«source», with the inputs typed into its form; see tools/ and README.md. «formulas» holds',
    'the formula of each output cell exactly as the workbook has it. Amounts: the workbook',
    'takes tomans; amountRial = amountToman × 10 (CLAUDE.md rule 1). null = an empty cell.',
  ],
  source: { workbook, sha256, excel: excel.excel, sheet: 'فرم ارزیابی' },
  outputs: OUTPUTS,
  formulas: excel.formulas,
  validations: excel.validations,
  options,
  cases,
};
writeFileSync(resolve(here, '../golden-v1.json'), JSON.stringify(golden, null, 2) + '\n');
process.stdout.write(`golden-v1.json: ${String(cases.length)} cases from ${workbook}\n`);
