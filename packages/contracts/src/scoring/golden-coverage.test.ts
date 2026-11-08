import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The golden cases of the scoring engine (task 3-1, doc 03 §9) are complete and consistent.
 * Their expected values come from Excel computing the client's workbook
 * (fixtures/scoring/tools); this test does not score anything. It fails when a mandatory
 * case of doc 03 §9 is missing, when the file contradicts itself, or when the workbook in
 * docs/source changed after the cases were made from it. The engine (task 3-2) is tested
 * against the same file.
 */

type Answers = Record<string, string> | null;
interface Party {
  scores: Record<string, number | null>;
  total: number | string | null;
  grade: string | null;
  stop: string | null;
}
interface Case {
  id: string;
  covers: string[];
  excelBug: string[];
  inputs: {
    amountToman: number | null;
    amountRial: string | null;
    borrower: Answers;
    guarantor1: Answers;
    guarantor2: Answers;
  };
  expected: {
    amountLevel: string | null;
    borrower: Party;
    guarantor1: Party & { weight: number };
    guarantor2: Party & { weight: number };
    sufficiency: string | null;
  };
}
interface Golden {
  source: { workbook: string; sha256: string };
  options: Record<
    'borrower' | 'guarantor',
    Record<string, { code: string; label: string; score: number }[]>
  >;
  cases: Case[];
}

const fixtures = resolve(import.meta.dirname, '../../fixtures/scoring');
const golden = JSON.parse(readFileSync(resolve(fixtures, 'golden-v1.json'), 'utf8')) as Golden;
const covered = new Set(golden.cases.flatMap((c) => c.covers));
const optionScore = (who: 'borrower' | 'guarantor', criterion: string, code: string) =>
  golden.options[who][criterion]?.find((o) => o.code === code)?.score;

const GRADES = ['alef', 'be', 'jim', 'dal'];
const LEVELS = ['kam', 'motevaset', 'ziad'];
const MANDATORY = [
  // Every stop condition.
  'stop_borrower_job',
  'stop_guarantor_job',
  'stop_guarantor_independence',
  // Each side of each score boundary.
  ...['borrower', 'guarantor'].flatMap((who) =>
    [45, 60, 80].flatMap((b) => [
      `${who}_boundary_${String(b)}_below`,
      `${who}_boundary_${String(b)}_at`,
    ]),
  ),
  // The twelve cells of the matrix.
  ...GRADES.flatMap((g) => LEVELS.map((l) => `matrix_${g}_${l}`)),
  // Guarantor weight combinations: one excellent, excellent + acceptable, two acceptable.
  'weights_3_none',
  'weights_3_2',
  'weights_2_2',
  // The amount on each level boundary, and past it.
  ...[4_000_000, 12_000_000, 20_000_000].flatMap((b) => [
    `amount_at_${String(b)}`,
    `amount_past_${String(b)}`,
  ]),
  // Incomplete data gives no score.
  'incomplete_borrower',
  'incomplete_guarantor',
  // Every option through the workbook's formulas.
  'options_borrower',
  'options_guarantor',
];

describe('golden scoring cases (doc 03 §9)', () => {
  it('are at least forty, each with its own id', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(golden.cases.map((c) => c.id)).size).toBe(golden.cases.length);
  });

  it('cover every mandatory case', () => {
    expect(MANDATORY.filter((m) => !covered.has(m))).toEqual([]);
    expect([...covered].some((c) => c.startsWith('out_of_cap_'))).toBe(true);
  });

  it('show both a sufficient and an insufficient outcome in every conditional cell', () => {
    const cells = new Map<string, Set<string>>();
    for (const c of golden.cases) {
      for (const cover of c.covers.filter((k) => /^weights_[a-z]+_[a-z]+$/.test(k))) {
        const outcomes = cells.get(cover) ?? new Set<string>();
        outcomes.add(c.expected.sufficiency?.startsWith('کافی') ? 'enough' : 'short');
        cells.set(cover, outcomes);
      }
    }
    expect(cells.size).toBe(7);
    for (const [cell, outcomes] of cells)
      expect([cell, [...outcomes].sort()]).toEqual([cell, ['enough', 'short']]);
  });

  it('pass every option of every criterion through the formulas', () => {
    for (const who of ['borrower', 'guarantor'] as const) {
      for (const [criterion, list] of Object.entries(golden.options[who])) {
        for (const { code } of list) {
          const used = golden.cases.some((c) =>
            (who === 'borrower'
              ? [c.inputs.borrower]
              : [c.inputs.guarantor1, c.inputs.guarantor2]
            ).some((a) => a?.[criterion] === code),
          );
          expect(used, `${who}.${criterion}.${code}`).toBe(true);
        }
      }
    }
  });

  it('label each of the workbook errors at least once, and only known ones', () => {
    const bugs = new Set(golden.cases.flatMap((c) => c.excelBug));
    for (const bug of bugs) expect(bug).toMatch(/^EXCEL-BUG-[1-8]$/);
    expect([...bugs].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `EXCEL-BUG-${String(n)}`));
  });

  it('agree with themselves: option scores, totals, incomplete parties and rials', () => {
    for (const c of golden.cases) {
      const parties = [
        ['borrower', 'borrower', c.inputs.borrower, c.expected.borrower, 4],
        ['guarantor', 'guarantor1', c.inputs.guarantor1, c.expected.guarantor1, 5],
        ['guarantor', 'guarantor2', c.inputs.guarantor2, c.expected.guarantor2, 5],
      ] as const;
      for (const [who, slot, answers, out, count] of parties) {
        const given = Object.entries(answers ?? {});
        for (const [criterion, code] of given) {
          expect(out.scores[criterion], `${c.id} ${slot}.${criterion}`).toBe(
            optionScore(who, criterion, code),
          );
        }
        const sum = given.reduce(
          (s, [criterion, code]) => s + (optionScore(who, criterion, code) ?? NaN),
          0,
        );
        if (given.length === count) expect(out.total, `${c.id} ${slot} total`).toBe(sum);
        else if (given.length === 0 || who === 'borrower') {
          // The workbook gives no total until every criterion is answered (no score from
          // incomplete data), and a borrower with any missing criterion has no grade.
          expect(out.total, `${c.id} ${slot} total`).toBeNull();
          expect(out.grade, `${c.id} ${slot} grade`).toBeNull();
        } else expect(out.total, `${c.id} ${slot} total`).toBe('ناقص');
      }
      expect(c.inputs.amountRial).toBe(
        c.inputs.amountToman === null ? null : String(c.inputs.amountToman * 10),
      );
    }
  });

  it('change grade exactly across each score boundary', () => {
    const byCover = (k: string) => golden.cases.find((c) => c.covers.includes(k));
    const grades: Record<string, Record<number, [string, string]>> = {
      borrower: { 45: ['د', 'ج'], 60: ['ج', 'ب'], 80: ['ب', 'الف'] },
      guarantor: {
        45: ['غیرقابل قبول', 'تکمیلی'],
        60: ['تکمیلی', 'قابل قبول'],
        80: ['قابل قبول', 'ممتاز'],
      },
    };
    for (const who of ['borrower', 'guarantor'] as const) {
      for (const boundary of [45, 60, 80]) {
        const below = byCover(`${who}_boundary_${String(boundary)}_below`);
        const at = byCover(`${who}_boundary_${String(boundary)}_at`);
        const party = (c: Case | undefined) =>
          who === 'borrower' ? c?.expected.borrower : c?.expected.guarantor1;
        expect(Number(party(below)?.total)).toBeLessThan(boundary);
        expect(party(at)?.total).toBe(boundary);
        expect([party(below)?.grade, party(at)?.grade]).toEqual(grades[who]?.[boundary]);
      }
    }
  });

  it('were made from the workbook now in docs/source', () => {
    const dir = resolve(import.meta.dirname, '../../../../docs/source');
    const workbook = readdirSync(dir).find((f) => f.endsWith('.xlsx'));
    expect(workbook).toBe(golden.source.workbook);
    const sha256 = createHash('sha256')
      .update(readFileSync(resolve(dir, workbook ?? '')))
      .digest('hex');
    expect(sha256).toBe(golden.source.sha256);
  });
});
