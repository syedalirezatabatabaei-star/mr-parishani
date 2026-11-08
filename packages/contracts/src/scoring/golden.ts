import {
  evaluate,
  ScoringInputError,
  type ScoringAnswerSet,
  type ScoringOutcome,
} from './engine.js';
import type { ScoringRuleset } from './ruleset.js';

/**
 * Runs the golden cases of the client's workbook (task 3-1,
 * fixtures/scoring/golden-v1.json) against a ruleset (task 3-2). A ruleset whose outcome
 * differs from Excel's on any case cannot be activated (doc 03 §8-3, doc 10 §10 test 1):
 * the API refuses it. The cases are passed in, so this stays pure and the file is read
 * by whoever runs it.
 */

type Answers = ScoringAnswerSet | null;
interface GoldenParty {
  readonly scores: Readonly<Record<string, number | null>>;
  readonly total: number | string | null;
  readonly stop: string | null;
  readonly grade: string | null;
}
export interface GoldenCase {
  readonly id: string;
  readonly excelBug: readonly string[];
  readonly inputs: {
    /** B7, the amount the workbook levels (EXCEL-BUG-4: never the approved H7). */
    readonly amountRial: string | null;
    readonly borrower: Answers;
    readonly guarantor1: Answers;
    readonly guarantor2: Answers;
  };
  readonly expected: {
    readonly amountLevel: string | null;
    readonly borrower: GoldenParty & { readonly interpretation: string | null };
    readonly guarantor1: GoldenParty & { readonly weight: number };
    readonly guarantor2: GoldenParty & { readonly weight: number };
    readonly requiredGuarantee: string | null;
    readonly sufficiency: string | null;
    readonly decisionAuthority: string | null;
  };
}
export interface GoldenFile {
  readonly source: { readonly workbook: string; readonly sha256: string };
  readonly cases: readonly GoldenCase[];
}

export interface GoldenFailure {
  readonly id: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** What the workbook's form would show for this outcome, cell by cell. */
function shown(rules: ScoringRuleset, outcome: ScoringOutcome) {
  const stop = (s: boolean | null) =>
    s === null ? null : s ? rules.stopLabels.yes : rules.stopLabels.no;
  const party = (
    p: ScoringOutcome['borrower'] | ScoringOutcome['guarantors'][number],
    incompleteLabel: string | null,
  ) => ({
    scores: p.scores,
    total: p.complete ? p.total : p.answered > 0 ? incompleteLabel : null,
    stop: stop(p.stop),
    grade: p.gradeLabel,
  });
  const g = (i: 0 | 1) => ({
    ...party(outcome.guarantors[i], rules.guarantor.incompleteLabel),
    weight: outcome.guarantors[i].weight,
  });
  return {
    amountLevel: outcome.amountLevel?.label ?? null,
    borrower: {
      ...party(outcome.borrower, rules.borrower.incompleteLabel),
      interpretation: outcome.borrower.interpretation,
    },
    guarantor1: g(0),
    guarantor2: g(1),
    requiredGuarantee: outcome.requirement?.label ?? null,
    sufficiency: outcome.sufficiency.label,
    decisionAuthority: outcome.authority?.label ?? null,
  };
}

function compare(
  id: string,
  path: string,
  expected: unknown,
  actual: unknown,
  out: GoldenFailure[],
) {
  if (expected !== null && typeof expected === 'object') {
    for (const [k, v] of Object.entries(expected)) {
      compare(id, `${path}.${k}`, v, (actual as Record<string, unknown> | null)?.[k], out);
    }
  } else if (expected !== actual) {
    out.push({ id, field: path.slice(1), expected, actual });
  }
}

/** Every difference between the ruleset's outcome and Excel's, over every case. */
export function runGoldenCases(rules: ScoringRuleset, golden: GoldenFile): GoldenFailure[] {
  const failures: GoldenFailure[] = [];
  for (const c of golden.cases) {
    let outcome: ScoringOutcome;
    try {
      outcome = evaluate(
        rules,
        { borrower: c.inputs.borrower, guarantors: [c.inputs.guarantor1, c.inputs.guarantor2] },
        c.inputs.amountRial === null ? null : BigInt(c.inputs.amountRial),
      );
    } catch (error) {
      if (!(error instanceof ScoringInputError)) throw error;
      failures.push({ id: c.id, field: '(input)', expected: 'a result', actual: error.message });
      continue;
    }
    compare(c.id, '', c.expected, shown(rules, outcome), failures);
  }
  return failures;
}
