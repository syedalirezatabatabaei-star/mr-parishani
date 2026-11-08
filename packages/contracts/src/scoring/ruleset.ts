import * as z from 'zod';

/**
 * The credit scoring rules (doc 03; task 3-2): data, versioned as the configuration key
 * `credit.scoring_ruleset` (ADR-006), never code. Version 1 is the client's workbook
 * (packages/contracts/fixtures/scoring/ruleset-v1.json). The engine (engine.ts) only
 * applies what is here; the stepped order of doc 03 §1 is the engine's, not the data's.
 */

const code = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const label = z.string().min(1).max(300);
const score = z.number().int().min(0).max(100);
const rial = z.string().regex(/^[1-9][0-9]{0,17}$/);
const ratio = z.object({ num: z.number().int().min(0), den: z.number().int().min(1) });

const optionSchema = z.object({
  code,
  /** Exactly as the workbook's dropdown has it. */
  label,
  score,
  /** Choosing it stops the case (doc 03 §2, §3: «شرط توقف»). */
  stop: z.boolean(),
});

const criterionSchema = z.object({
  code,
  label,
  options: z.array(optionSchema).min(2),
});

const partyBase = {
  criteria: z.array(criterionSchema).min(1),
  /**
   * Answers whose absence leaves «stop» unknown. Empty: unknown only while nothing is
   * answered. (The workbook asks the borrower's job for it; a guarantor's any answer.)
   */
  stopNeeds: z.array(code),
  /** What the total shows while only some criteria are answered; null shows nothing. */
  incompleteLabel: label.nullable(),
};

const borrowerSchema = z.object({
  ...partyBase,
  /** Highest first: the first band whose minimum the total reaches. */
  grades: z.array(
    z.object({ grade: code, label, minTotal: score, interpretation: label, reject: z.boolean() }),
  ),
  /** The grade of a total below every band, and of a stopped borrower. */
  fallback: z.object({ grade: code, label, interpretation: label, reject: z.boolean() }),
});

const guarantorSchema = z.object({
  ...partyBase,
  grades: z.array(
    z.object({ grade: code, label, minTotal: score, weight: z.number().int().min(0).max(3) }),
  ),
  /** Below every band, or stopped: weight 0. */
  fallback: z.object({ grade: code, label, weight: z.literal(0) }),
});

/** One test on the two guarantors' weights (a missing guarantor weighs 0). */
const weightTest = z.object({
  stat: z.enum(['max', 'min', 'sum']),
  atLeast: z.number().int().min(0).max(6),
});

const sufficiencySchema = z.discriminatedUnion('kind', [
  /** No third-party guarantor needed: always sufficient. */
  z.object({ kind: z.literal('not_required'), label }),
  /** Sufficient when every test of any one group holds. */
  z.object({
    kind: z.literal('weights'),
    anyOf: z.array(z.array(weightTest).min(1)).min(1),
    passLabel: label,
    failLabel: label,
  }),
  /** Not in the normal path at all. */
  z.object({ kind: z.literal('reject'), label }),
]);

export const scoringRulesetSchema = z
  .object({
    version: z.number().int().min(1),
    /** Where the rules come from, for the reader of the history. */
    source: label,
    borrower: borrowerSchema,
    guarantor: guarantorSchema,
    stopLabels: z.object({ yes: label, no: label }),
    amountLevels: z.object({
      /** Ascending: the first level whose ceiling the amount does not pass. */
      levels: z.array(z.object({ level: code, label, upToRial: rial })).min(1),
      overCap: z.object({ level: code, label }),
    }),
    /** One cell per non-rejected grade and level (doc 03 §5). */
    matrix: z.array(
      z.object({
        grade: code,
        level: code,
        requirement: label,
        /** The requirement asks for two guarantors (it routes the decision, doc 03 §6). */
        twoGuarantors: z.boolean(),
        sufficiency: sufficiencySchema,
      }),
    ),
    requirementLabels: z.object({ overCap: label, reject: label }),
    sufficiencyLabels: z.object({ incomplete: label, notReviewable: label }),
    /** Doc 03 §6, in order: the first rule that matches decides. */
    authority: z.object({
      reject: z.object({ authority: code, label }),
      rules: z.array(
        z.object({
          levels: z.array(code).optional(),
          grades: z.array(code).optional(),
          twoGuarantors: z.literal(true).optional(),
          authority: code,
          label,
        }),
      ),
      fallback: z.object({ authority: code, label }),
    }),
    /** How raw data becomes an option (doc 03 §8-1); not in the workbook, see doc 03 §2–3. */
    raw: z.object({
      /** Completed Jalali years of employment, both parties; highest first. */
      tenure: z.object({
        criterion: code,
        bands: z.array(z.object({ option: code, minYears: z.number().int().min(0) })),
        otherwise: code,
      }),
      /** Borrower's earlier obligations ÷ the new installment; lowest first, inclusive. */
      obligations: z.object({
        criterion: code,
        bands: z.array(z.object({ option: code, atMost: ratio })),
        otherwise: code,
      }),
      /** Guarantor's average balance ÷ the installment; highest first, inclusive. */
      guarantorCoverage: z.object({
        criterion: code,
        bands: z.array(z.object({ option: code, atLeast: ratio })),
        otherwise: code,
      }),
    }),
    /** The workbook's known errors kept as they are, for the reader (doc 03 §7). */
    excelBugs: z.array(z.object({ id: z.string().regex(/^EXCEL-BUG-\d+$/), note: label })),
  })
  .superRefine((r, ctx) => {
    const issue = (message: string) => {
      ctx.addIssue({ code: 'custom', message });
    };
    for (const [who, party] of [
      ['borrower', r.borrower],
      ['guarantor', r.guarantor],
    ] as const) {
      const criteria = new Set(party.criteria.map((c) => c.code));
      if (criteria.size !== party.criteria.length) issue(`${who}: a criterion appears twice`);
      for (const c of party.criteria) {
        if (new Set(c.options.map((o) => o.code)).size !== c.options.length) {
          issue(`${who}.${c.code}: an option appears twice`);
        }
      }
      for (const needed of party.stopNeeds) {
        if (!criteria.has(needed)) issue(`${who}: stopNeeds names no criterion ${needed}`);
      }
      const mins = party.grades.map((g) => g.minTotal);
      if (mins.some((m, i) => i > 0 && m >= (mins[i - 1] ?? 0))) {
        issue(`${who}: grades must go from the highest minimum down`);
      }
    }
    const ceilings = r.amountLevels.levels.map((l) => BigInt(l.upToRial));
    if (ceilings.some((c, i) => i > 0 && c <= (ceilings[i - 1] ?? 0n))) {
      issue('amount levels must rise');
    }
    const grades = [...r.borrower.grades, r.borrower.fallback]
      .filter((g) => !g.reject)
      .map((g) => g.grade);
    for (const grade of grades) {
      for (const { level } of r.amountLevels.levels) {
        const cells = r.matrix.filter((m) => m.grade === grade && m.level === level);
        if (cells.length !== 1) issue(`matrix needs exactly one cell for ${grade} · ${level}`);
      }
    }
    const optionsOf = (who: 'borrower' | 'guarantor', criterion: string) =>
      new Set(r[who].criteria.find((c) => c.code === criterion)?.options.map((o) => o.code));
    const bandOptions = (
      who: 'borrower' | 'guarantor',
      raw: { criterion: string; bands: { option: string }[]; otherwise: string },
    ) => {
      const known = optionsOf(who, raw.criterion);
      for (const option of [...raw.bands.map((b) => b.option), raw.otherwise]) {
        if (!known.has(option)) issue(`raw ${who}.${raw.criterion}: no option ${option}`);
      }
    };
    bandOptions('borrower', r.raw.tenure);
    bandOptions('guarantor', r.raw.tenure);
    bandOptions('borrower', r.raw.obligations);
    bandOptions('guarantor', r.raw.guarantorCoverage);
  });

export type ScoringRuleset = z.infer<typeof scoringRulesetSchema>;
export type ScoringSufficiencyRule = ScoringRuleset['matrix'][number]['sufficiency'];
