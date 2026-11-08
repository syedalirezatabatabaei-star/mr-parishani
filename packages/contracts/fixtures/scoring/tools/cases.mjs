// Golden cases for the credit scoring engine (task 3-1; doc 03 §9). This file only says
// WHICH inputs to try; every expected output comes from the client's workbook itself,
// recalculated by Excel (evaluate-in-excel.ps1), never from this file.
//
//   node tools/cases.mjs > tools/cases.json
//
// Option codes are ours (stable, English); each points at the cell of «جداول پایه» that
// holds its Persian label, which Excel types into the form exactly as its dropdown would.
// The scores listed here are only for finding boundary combinations; the workbook's own
// formulas score every case.

/** criterion → [code, base-table cell, score in the base table] */
const OPTIONS = {
  borrower: {
    job: [
      ['official', 'A2', 25],
      ['self_employed_over_5', 'A3', 20],
      ['self_employed_under_5', 'A4', 15],
      ['none_stop', 'A5', 0],
    ],
    tenure: [
      ['years_5_plus', 'A8', 25],
      ['years_2_to_5', 'A9', 18],
      ['years_1_to_2', 'A10', 10],
      ['under_1_year', 'A11', 5],
    ],
    coverage: [
      ['full', 'A14', 25],
      ['over_90', 'A15', 20],
      ['from_85_to_90', 'A16', 12],
      ['from_80_to_85', 'A17', 5],
      ['under_80', 'A18', 0],
    ],
    obligations: [
      ['up_to_quarter', 'A21', 25],
      ['up_to_half', 'A22', 15],
      ['up_to_equal', 'A23', 10],
      ['up_to_one_and_half', 'A24', 5],
      ['over_one_and_half', 'A25', 2],
    ],
  },
  guarantor: {
    job: [
      ['official', 'A28', 25],
      ['self_employed_over_5', 'A29', 20],
      ['self_employed_under_5', 'A30', 15],
      ['none_stop', 'A31', 0],
    ],
    tenure: [
      ['years_5_plus', 'A34', 25],
      ['years_2_to_5', 'A35', 18],
      ['years_1_to_2', 'A36', 10],
      ['under_1_year', 'A37', 5],
    ],
    coverage: [
      ['installments_3_plus', 'A40', 25],
      ['installments_2_to_3', 'A41', 20],
      ['installments_1_to_2', 'A42', 12],
      ['installments_half_to_1', 'A43', 5],
      ['under_half_installment', 'A44', 0],
    ],
    debts: [
      ['none_or_very_low', 'A47', 15],
      ['low', 'A48', 12],
      ['medium', 'A49', 7],
      ['high', 'A50', 3],
      ['unknown_or_very_high', 'A51', 0],
    ],
    independence: [
      // EXCEL-BUG-7: the form's dropdown starts at A55, so A54 cannot be picked there;
      // the formula still scores it.
      ['fully_independent', 'A54', 10],
      ['colleague_independent', 'A55', 7],
      ['household_own_income', 'A56', 5],
      ['dependent_stop', 'A57', 0],
    ],
  },
};

const STOPS = new Set(['none_stop', 'dependent_stop']);
/** The first combination (no stop) of `who`'s criteria whose base-table scores add to `total`. */
function combination(who, total) {
  const criteria = Object.keys(OPTIONS[who]);
  const pick = (i, sum, chosen) => {
    if (i === criteria.length) return sum === total ? chosen : null;
    for (const [code, , score] of OPTIONS[who][criteria[i]]) {
      if (STOPS.has(code)) continue;
      const found = pick(i + 1, sum + score, { ...chosen, [criteria[i]]: code });
      if (found) return found;
    }
    return null;
  };
  const found = pick(0, 0, {});
  if (!found) throw new Error(`no ${who} combination adds to ${String(total)}`);
  return found;
}

// Borrowers by grade (doc 03 §2: الف ≥ 80, ب 60–79, ج 45–59, د < 45).
const BORROWER = {
  alef: combination('borrower', 100),
  be: combination('borrower', 70),
  jim: combination('borrower', 50),
  dal: combination('borrower', 30),
};
// Guarantors by weight (doc 03 §3: 3 ممتاز ≥ 80, 2 قابل قبول 60–79, 1 تکمیلی 45–59, 0).
const GUARANTOR = {
  3: combination('guarantor', 100),
  2: combination('guarantor', 70),
  1: combination('guarantor', 50),
  0: combination('guarantor', 30),
};
// Amounts in tomans, as the workbook takes them (doc 03 §4).
const LEVEL = { kam: 3_000_000, motevaset: 8_000_000, ziad: 15_000_000, kharej: 25_000_000 };

const cases = [];
function add(id, title, inputs, covers, excelBug = []) {
  if (cases.some((c) => c.id === id)) throw new Error(`duplicate case ${id}`);
  cases.push({
    id,
    title,
    covers,
    excelBug,
    inputs: {
      amountToman: null,
      approvedToman: null,
      guarantorsShareIncome: null,
      borrower: null,
      guarantor1: null,
      guarantor2: null,
      ...inputs,
    },
  });
}

/** Every total `who`'s options can reach without a stop. */
function reachable(who) {
  let totals = new Set([0]);
  for (const list of Object.values(OPTIONS[who])) {
    const next = new Set();
    for (const t of totals) {
      for (const [code, , score] of list) if (!STOPS.has(code)) next.add(t + score);
    }
    totals = next;
  }
  return [...totals];
}

// 1. Each side of each score boundary (doc 03 §9: 44/45, 59/60, 79/80), borrower and
// guarantor. A total the options cannot reach (a borrower cannot total 79) is replaced by
// the nearest reachable one on the same side.
for (const who of ['borrower', 'guarantor']) {
  const totals = reachable(who);
  for (const boundary of [45, 60, 80]) {
    const sides = {
      below: Math.max(...totals.filter((t) => t < boundary)),
      at: Math.min(...totals.filter((t) => t >= boundary)),
    };
    for (const [side, total] of Object.entries(sides)) {
      add(
        `${who}-total-${String(total)}`,
        who === 'borrower'
          ? `borrower total ${String(total)}`
          : `first guarantor total ${String(total)}, borrower ب, amount کم`,
        who === 'borrower'
          ? { amountToman: LEVEL.kam, borrower: combination(who, total), guarantor1: GUARANTOR[3] }
          : { amountToman: LEVEL.kam, borrower: BORROWER.be, guarantor1: combination(who, total) },
        [`${who}_boundary_${String(boundary)}_${side}`],
      );
    }
  }
}

// 2. Every stop condition, with otherwise strong answers.
add(
  'stop-borrower-job',
  'borrower without documented job: stop, grade د whatever the rest',
  {
    amountToman: LEVEL.kam,
    borrower: { ...BORROWER.alef, job: 'none_stop' },
    guarantor1: GUARANTOR[3],
  },
  ['stop_borrower_job'],
);
add(
  'stop-guarantor-job',
  'guarantor without documented job: unacceptable, weight 0',
  {
    amountToman: LEVEL.kam,
    borrower: BORROWER.be,
    guarantor1: { ...GUARANTOR[3], job: 'none_stop' },
  },
  ['stop_guarantor_job'],
);
add(
  'stop-guarantor-independence',
  'guarantor dependent on the borrower: unacceptable, weight 0',
  {
    amountToman: LEVEL.kam,
    borrower: BORROWER.be,
    guarantor1: { ...GUARANTOR[3], independence: 'dependent_stop' },
  },
  ['stop_guarantor_independence'],
);

// 3. The twelve cells of the matrix (doc 03 §5) and beyond the cap, with two excellent
// guarantors so sufficiency shows wherever the cell allows it.
const GRADES = { alef: 'الف', be: 'ب', jim: 'ج', dal: 'د' };
for (const [grade, persian] of Object.entries(GRADES)) {
  for (const level of ['kam', 'motevaset', 'ziad', 'kharej']) {
    const bugs = [];
    if (grade === 'alef' && level === 'ziad') bugs.push('EXCEL-BUG-3');
    if (level === 'ziad' && grade === 'be') bugs.push('EXCEL-BUG-3');
    if (level === 'kharej' && (grade === 'alef' || grade === 'be')) bugs.push('EXCEL-BUG-8');
    add(
      `matrix-${grade}-${level}`,
      `matrix cell ${persian} · ${level}, two excellent guarantors`,
      {
        amountToman: LEVEL[level],
        borrower: BORROWER[grade],
        guarantor1: GUARANTOR[3],
        guarantor2: GUARANTOR[3],
      },
      [level === 'kharej' ? `out_of_cap_${grade}` : `matrix_${grade}_${level}`],
      bugs,
    );
  }
}

// 4. Guarantor weight combinations in every cell whose sufficiency depends on them.
const CONDITIONAL = [
  ['alef', 'motevaset'],
  ['alef', 'ziad'],
  ['be', 'kam'],
  ['be', 'motevaset'],
  ['be', 'ziad'],
  ['jim', 'kam'],
  ['jim', 'motevaset'],
];
const WEIGHTS = [
  [3, null],
  [2, null],
  [1, null],
  [3, 3],
  [3, 2],
  [2, 2],
  [3, 1],
  [2, 1],
  [3, 0],
];
for (const [grade, level] of CONDITIONAL) {
  for (const [w1, w2] of WEIGHTS) {
    const bugs = [];
    // EXCEL-BUG-2: an excellent and a supplementary guarantor never satisfy a two-guarantor cell.
    if (w1 === 3 && w2 === 1 && (level === 'ziad' || (grade === 'jim' && level === 'motevaset'))) {
      bugs.push('EXCEL-BUG-2');
    }
    add(
      `weights-${grade}-${level}-${String(w1)}-${w2 === null ? 'none' : String(w2)}`,
      `${GRADES[grade]} · ${level}, guarantor weights ${String(w1)} and ${w2 === null ? '—' : String(w2)}`,
      {
        amountToman: LEVEL[level],
        borrower: BORROWER[grade],
        guarantor1: GUARANTOR[w1],
        guarantor2: w2 === null ? null : GUARANTOR[w2],
      },
      [`weights_${grade}_${level}`, `weights_${String(w1)}_${w2 === null ? 'none' : String(w2)}`],
      bugs,
    );
  }
}

// 5. The amount exactly on each level boundary, and one toman past it.
for (const boundary of [4_000_000, 12_000_000, 20_000_000]) {
  for (const amount of [boundary, boundary + 1]) {
    add(
      `amount-${String(amount)}`,
      `amount ${String(amount)} tomans`,
      {
        amountToman: amount,
        borrower: BORROWER.alef,
        guarantor1: GUARANTOR[3],
        guarantor2: GUARANTOR[3],
      },
      [`amount_${amount === boundary ? 'at' : 'past'}_${String(boundary)}`],
    );
  }
}

// 6. Incomplete data: no score, no decision (doc 03 §9).
add(
  'incomplete-borrower',
  'borrower with three of four criteria: no total, no grade, no decision',
  {
    amountToman: LEVEL.kam,
    borrower: {
      job: BORROWER.alef.job,
      tenure: BORROWER.alef.tenure,
      coverage: BORROWER.alef.coverage,
    },
    guarantor1: GUARANTOR[3],
  },
  ['incomplete_borrower'],
);
add(
  'incomplete-borrower-stop-only',
  'borrower with only a stopping job: the stop shows, still no grade',
  { amountToman: LEVEL.kam, borrower: { job: 'none_stop' } },
  ['incomplete_borrower'],
);
add(
  'incomplete-guarantor',
  'first guarantor with three of five criteria: «ناقص», weight 0',
  {
    amountToman: LEVEL.kam,
    borrower: BORROWER.be,
    guarantor1: {
      job: GUARANTOR[3].job,
      tenure: GUARANTOR[3].tenure,
      coverage: GUARANTOR[3].coverage,
    },
  },
  ['incomplete_guarantor'],
);
add(
  'missing-amount',
  'no amount: no level, no requirement, no decision',
  { borrower: BORROWER.alef, guarantor1: GUARANTOR[3] },
  ['missing_amount'],
);

// 7. Every option of every criterion goes through the workbook's formulas once.
for (const who of ['borrower', 'guarantor']) {
  const criteria = Object.keys(OPTIONS[who]);
  const rows = Math.max(...criteria.map((c) => OPTIONS[who][c].length));
  for (let i = 0; i < rows; i++) {
    const inputs = Object.fromEntries(
      criteria.map((c) => [c, OPTIONS[who][c][Math.min(i, OPTIONS[who][c].length - 1)][0]]),
    );
    const bugs = [];
    if (who === 'borrower') bugs.push('EXCEL-BUG-5');
    if (who === 'guarantor' && inputs.independence === 'fully_independent')
      bugs.push('EXCEL-BUG-7');
    add(
      `options-${who}-${String(i + 1)}`,
      `${who} options, row ${String(i + 1)} of each criterion`,
      who === 'borrower'
        ? { amountToman: LEVEL.kam, borrower: inputs }
        : { amountToman: LEVEL.kam, borrower: BORROWER.be, guarantor1: inputs },
      [`options_${who}`],
      bugs,
    );
  }
}

// 8. The workbook's known errors (doc 03 §7), each shown on its own.
add(
  'bug-1-shared-income',
  'two acceptable guarantors who share an income source still count as two',
  {
    amountToman: LEVEL.motevaset,
    borrower: BORROWER.be,
    guarantor1: GUARANTOR[2],
    guarantor2: GUARANTOR[2],
    guarantorsShareIncome: 'بله',
  },
  ['excel_bug_1'],
  ['EXCEL-BUG-1'],
);
add(
  'bug-4-approved-amount-ignored',
  'a lower approved amount (H7) leaves the level of the requested amount',
  {
    amountToman: LEVEL.ziad,
    approvedToman: LEVEL.kam,
    borrower: BORROWER.alef,
    guarantor1: GUARANTOR[3],
  },
  ['excel_bug_4'],
  ['EXCEL-BUG-4'],
);
add(
  'bug-6-low-coverage-not-a-stop',
  'coverage under 80% scores 0 but does not stop',
  {
    amountToman: LEVEL.kam,
    borrower: { ...BORROWER.alef, coverage: 'under_80' },
    guarantor1: GUARANTOR[3],
  },
  ['excel_bug_6'],
  ['EXCEL-BUG-6'],
);

process.stdout.write(
  JSON.stringify(
    {
      options: Object.fromEntries(
        Object.entries(OPTIONS).map(([who, criteria]) => [
          who,
          Object.fromEntries(
            Object.entries(criteria).map(([criterion, list]) => [
              criterion,
              list.map(([code, cell]) => ({ code, cell })),
            ]),
          ),
        ]),
      ),
      cases,
    },
    null,
    2,
  ) + '\n',
);
