import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classify,
  completedJalaliYears,
  evaluate,
  score,
  ScoringInputError,
  type ScoringAnswers,
} from './engine.js';
import { runGoldenCases, type GoldenFile } from './golden.js';
import { rawScoringDataSchema } from './inputs.js';
import { scoringRulesetSchema, type ScoringRuleset } from './ruleset.js';

const fixtures = resolve(import.meta.dirname, '../../fixtures/scoring');
const json = (file: string): unknown => JSON.parse(readFileSync(resolve(fixtures, file), 'utf8'));
const v1 = scoringRulesetSchema.parse(json('ruleset-v1.json'));
const golden = json('golden-v1.json') as GoldenFile;
const copy = (): ScoringRuleset => structuredClone(v1);

const strong = {
  job: 'official',
  tenure: 'years_5_plus',
  coverage: 'full',
  obligations: 'up_to_quarter',
};
const excellent = {
  job: 'official',
  tenure: 'years_5_plus',
  coverage: 'installments_3_plus',
  debts: 'none_or_very_low',
  independence: 'fully_independent',
};
const answers = (
  borrower: Record<string, string> = strong,
  g1: Record<string, string> | null = null,
): ScoringAnswers => ({
  borrower,
  guarantors: [g1, null],
});

describe('the scoring engine on the golden cases of the workbook (doc 10 §10 test 1)', () => {
  it('gives exactly what Excel gave, on every case, with ruleset version 1', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(40);
    expect(runGoldenCases(v1, golden)).toEqual([]);
  });

  it('fails the golden cases when a rule moves, so such a version cannot be activated', () => {
    const moved = copy();
    const alef = moved.borrower.grades[0];
    if (alef) alef.minTotal = 81;
    const failures = runGoldenCases(moved, golden);
    expect(failures.map((f) => f.id)).toContain('borrower-total-80');

    const relaxed = copy();
    const cell = relaxed.matrix.find((m) => m.grade === 'be' && m.level === 'high');
    if (cell?.sufficiency.kind === 'weights')
      cell.sufficiency.anyOf = [[{ stat: 'sum', atLeast: 4 }]];
    expect(runGoldenCases(relaxed, golden).map((f) => f.id)).toContain('weights-be-ziad-3-1');
  });

  it('keeps the workbook errors 7 and 8 as Excel has them (owner, 1405/07/10)', () => {
    // EXCEL-BUG-7: «fully independent» scores 10, though the form cannot pick it.
    const g = evaluate(v1, answers(strong, excellent), 30_000_000n).guarantors[0];
    expect([g.scores['independence'], g.total, g.weight]).toEqual([10, 100, 3]);
    // EXCEL-BUG-8: beyond the cap with grade الف reaches the specialist, not the committee.
    const over = evaluate(v1, answers(), 250_000_000n);
    expect(over.requirement?.label).toBe('خارج از سقف محصول؛ ارجاع به کمیته');
    expect(over.authority?.authority).toBe('expert_second_check');
  });
});

describe('the amount level of the final amount (doc 03 §4; EXCEL-BUG-4 corrected)', () => {
  it('is computed from whatever amount it is given, so a reduced amount is levelled again', () => {
    const requested = evaluate(v1, answers(strong, excellent), 150_000_000n);
    const approved = evaluate(v1, answers(strong, excellent), 40_000_000n);
    expect(requested.amountLevel?.level).toBe('high');
    expect(requested.authority?.authority).toBe('committee');
    expect(approved.amountLevel?.level).toBe('low');
    expect(approved.authority?.authority).toBe('expert_second_check');
  });

  it('has its boundaries in rials, inclusive', () => {
    const level = (rial: bigint) => evaluate(v1, answers(), rial).amountLevel?.level;
    expect([40_000_000n, 40_000_001n, 120_000_000n, 200_000_000n, 200_000_001n].map(level)).toEqual(
      ['low', 'medium', 'medium', 'high', 'over_cap'],
    );
  });
});

describe('raw data to options (doc 03 §8-1)', () => {
  const day = (year: number, month: number, d: number) => ({ year, month, day: d });

  it('counts completed Jalali years of employment', () => {
    expect(completedJalaliYears(day(1400, 7, 10), day(1405, 7, 10))).toBe(5);
    expect(completedJalaliYears(day(1400, 7, 11), day(1405, 7, 10))).toBe(4);
    expect(() => completedJalaliYears(day(1405, 7, 11), day(1405, 7, 10))).toThrow(
      ScoringInputError,
    );
    const tenure = (started: ReturnType<typeof day>) =>
      classify(v1, { borrower: { employmentStartedOn: started }, guarantors: [] }, day(1405, 7, 10))
        .borrower?.['tenure'];
    expect(
      [
        day(1400, 7, 10),
        day(1400, 7, 11),
        day(1403, 7, 10),
        day(1404, 7, 10),
        day(1404, 7, 11),
      ].map(tenure),
    ).toEqual(['years_5_plus', 'years_2_to_5', 'years_2_to_5', 'years_1_to_2', 'under_1_year']);
  });

  it('bands obligations against the new installment, each bound inclusive', () => {
    const band = (obligations: bigint) =>
      classify(
        v1,
        {
          borrower: { obligationsRial: obligations, newInstallmentRial: 4_000_000n },
          guarantors: [],
        },
        day(1405, 7, 10),
      ).borrower?.['obligations'];
    expect(
      [0n, 1_000_000n, 1_000_001n, 2_000_000n, 4_000_000n, 6_000_000n, 6_000_001n].map(band),
    ).toEqual([
      'up_to_quarter',
      'up_to_quarter',
      'up_to_half',
      'up_to_half',
      'up_to_equal',
      'up_to_one_and_half',
      'over_one_and_half',
    ]);
  });

  it('bands a guarantor’s average balance in installments, each bound inclusive', () => {
    const band = (balance: bigint) =>
      classify(
        v1,
        {
          borrower: {},
          guarantors: [{ averageBalanceRial: balance, installmentRial: 2_000_000n }],
        },
        day(1405, 7, 10),
      ).guarantors[0]?.['coverage'];
    expect(
      [6_000_000n, 5_999_999n, 4_000_000n, 2_000_000n, 1_000_000n, 999_999n].map(band),
    ).toEqual([
      'installments_3_plus',
      'installments_2_to_3',
      'installments_2_to_3',
      'installments_1_to_2',
      'installments_half_to_1',
      'under_half_installment',
    ]);
  });

  it('scores raw data end to end; what is missing leaves no score', () => {
    const raw = {
      borrower: {
        job: 'official',
        employmentStartedOn: day(1398, 1, 1),
        coverage: 'full',
        obligationsRial: 1_000_000n,
        newInstallmentRial: 4_000_000n,
      },
      guarantors: [],
    };
    const { answers: chosen, outcome } = score(v1, raw, 30_000_000n, day(1405, 7, 10));
    expect(chosen.borrower).toEqual(strong);
    expect([outcome.borrower.total, outcome.borrower.grade, outcome.authority?.authority]).toEqual([
      100,
      'alef',
      'expert_second_check',
    ]);

    const partial = score(
      v1,
      { borrower: { ...raw.borrower, newInstallmentRial: undefined }, guarantors: [] },
      30_000_000n,
      day(1405, 7, 10),
    ).outcome;
    expect([partial.borrower.total, partial.borrower.grade, partial.sufficiency.outcome]).toEqual([
      null,
      null,
      'incomplete',
    ]);
  });

  it('refuses an unknown option or criterion, and a zero installment', () => {
    expect(() => evaluate(v1, answers({ ...strong, job: 'doctor' }), 1n)).toThrow(
      ScoringInputError,
    );
    expect(() => evaluate(v1, answers({ ...strong, treatment: 'implant' }), 1n)).toThrow(
      ScoringInputError,
    );
    expect(() =>
      classify(
        v1,
        { borrower: { obligationsRial: 1n, newInstallmentRial: 0n }, guarantors: [] },
        day(1405, 1, 1),
      ),
    ).toThrow(ScoringInputError);
  });
});

describe('no medical data in a score sheet (doc 03 §8-2; doc 10 §10 test 12)', () => {
  const base = { borrower: { job: 'official' }, guarantors: [{ job: 'official' }] };

  it('accepts the raw data fields, with rials as text', () => {
    const parsed = rawScoringDataSchema.parse({
      ...base,
      borrower: { job: 'official', obligationsRial: '۱۰۰۰۰۰۰', newInstallmentRial: '4000000' },
    });
    expect(parsed.borrower.obligationsRial).toBe(1_000_000n);
  });

  it.each([
    ['treatmentField', 'implant'],
    ['diagnosis', 'x'],
    ['doctorId', '0190a000-0000-7000-8000-000000000000'],
    ['centerId', '0190a000-0000-7000-8000-000000000000'],
    ['proformaLines', []],
    ['note', 'درمان ریشه'],
  ])('refuses «%s» anywhere in it', (field, value) => {
    expect(rawScoringDataSchema.safeParse({ ...base, [field]: value }).success).toBe(false);
    expect(
      rawScoringDataSchema.safeParse({ ...base, borrower: { ...base.borrower, [field]: value } })
        .success,
    ).toBe(false);
    expect(
      rawScoringDataSchema.safeParse({ ...base, guarantors: [{ job: 'official', [field]: value }] })
        .success,
    ).toBe(false);
  });
});

describe('the ruleset schema', () => {
  it('needs a matrix cell for every grade that is not rejected and every level', () => {
    const broken = copy();
    broken.matrix = broken.matrix.filter((m) => !(m.grade === 'jim' && m.level === 'high'));
    expect(scoringRulesetSchema.safeParse(broken).success).toBe(false);
  });

  it('needs raw bands that name real options, and rising amount levels', () => {
    const badBand = copy();
    badBand.raw.tenure.otherwise = 'forever';
    expect(scoringRulesetSchema.safeParse(badBand).success).toBe(false);
    const badLevels = copy();
    const medium = badLevels.amountLevels.levels[1];
    if (medium) medium.upToRial = '10';
    expect(scoringRulesetSchema.safeParse(badLevels).success).toBe(false);
  });
});
