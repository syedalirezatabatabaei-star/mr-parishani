import { compareJalali, type JalaliDate } from '../jalali/calendar.js';
import type { ScoringRuleset, ScoringSufficiencyRule } from './ruleset.js';

/**
 * The credit scoring engine (doc 03, doc 10 §5; task 3-2): a pure function of the rules
 * and the answers. No database, no clock, no side effect, so the golden cases of the
 * client's workbook (task 3-1) run against it as they are. It proposes; the decision is
 * always a person's (doc 03 §8-5).
 *
 * The workbook's errors are kept as the workbook has them (doc 03 §7, doc 10 §5) and
 * marked EXCEL-BUG-n where they live: in the data (ruleset-v1.json) or here.
 */

export class ScoringInputError extends Error {}

/** A party's answers: criterion code → option code. A missing criterion is unanswered. */
export type ScoringAnswerSet = Readonly<Record<string, string>>;

export interface ScoringAnswers {
  readonly borrower: ScoringAnswerSet | null;
  readonly guarantors: readonly [ScoringAnswerSet | null, ScoringAnswerSet | null];
}

interface PartyBase {
  /** Criterion → its option's score; null while unanswered. */
  readonly scores: Readonly<Record<string, number | null>>;
  readonly answered: number;
  /** Every criterion answered; only then is there a total (no score from incomplete data). */
  readonly complete: boolean;
  readonly total: number | null;
  /** null while it cannot be known yet. */
  readonly stop: boolean | null;
  readonly grade: string | null;
  readonly gradeLabel: string | null;
}
export interface BorrowerOutcome extends PartyBase {
  readonly interpretation: string | null;
  /** The grade rejects the case outright (doc 03 §6: «رد؛ بدون اختیار عبور فردی»). */
  readonly reject: boolean;
}
export interface GuarantorOutcome extends PartyBase {
  /** 3 excellent, 2 acceptable, 1 supplementary, 0 otherwise, or no guarantor. */
  readonly weight: number;
}

export type SufficiencyOutcome =
  'incomplete' | 'not_reviewable' | 'not_required' | 'sufficient' | 'insufficient' | 'reject';

export interface ScoringOutcome {
  readonly amountLevel: { readonly level: string; readonly label: string } | null;
  readonly borrower: BorrowerOutcome;
  readonly guarantors: readonly [GuarantorOutcome, GuarantorOutcome];
  /** The guarantee the case needs (doc 03 §5); null until grade and level are known. */
  readonly requirement: { readonly label: string; readonly twoGuarantors: boolean } | null;
  readonly sufficiency: { readonly outcome: SufficiencyOutcome; readonly label: string };
  /** Who decides (doc 03 §6); null until grade and level are known. */
  readonly authority: { readonly authority: string; readonly label: string } | null;
}

type PartyRules = ScoringRuleset['borrower'] | ScoringRuleset['guarantor'];

function tally(rules: PartyRules, answers: ScoringAnswerSet | null, who: string) {
  const known = new Set(rules.criteria.map((c) => c.code));
  for (const criterion of Object.keys(answers ?? {})) {
    if (!known.has(criterion)) throw new ScoringInputError(`${who}: no criterion ${criterion}`);
  }
  const scores: Record<string, number | null> = {};
  let answered = 0;
  let sum = 0;
  let stop = false;
  for (const criterion of rules.criteria) {
    const chosen = answers?.[criterion.code];
    if (chosen === undefined) {
      scores[criterion.code] = null;
      continue;
    }
    const option = criterion.options.find((o) => o.code === chosen);
    if (!option) throw new ScoringInputError(`${who}.${criterion.code}: no option ${chosen}`);
    scores[criterion.code] = option.score;
    answered += 1;
    sum += option.score;
    if (option.stop) stop = true;
  }
  const complete = answered === rules.criteria.length;
  const stopKnown = answered > 0 && rules.stopNeeds.every((c) => answers?.[c] !== undefined);
  return {
    scores,
    answered,
    complete,
    total: complete ? sum : null,
    stop: stopKnown ? stop : null,
  };
}

function borrowerOutcome(rules: ScoringRuleset, answers: ScoringAnswerSet | null): BorrowerOutcome {
  const t = tally(rules.borrower, answers, 'borrower');
  if (t.total === null) {
    return { ...t, grade: null, gradeLabel: null, interpretation: null, reject: false };
  }
  const total = t.total;
  // A stop gives the lowest grade whatever the total (doc 03 §2).
  const band = t.stop === true ? undefined : rules.borrower.grades.find((g) => total >= g.minTotal);
  const grade = band ?? rules.borrower.fallback;
  return {
    ...t,
    grade: grade.grade,
    gradeLabel: grade.label,
    interpretation: grade.interpretation,
    reject: grade.reject,
  };
}

function guarantorOutcome(
  rules: ScoringRuleset,
  answers: ScoringAnswerSet | null,
  who: string,
): GuarantorOutcome {
  const t = tally(rules.guarantor, answers, who);
  if (t.total === null) return { ...t, grade: null, gradeLabel: null, weight: 0 };
  const total = t.total;
  const band =
    t.stop === true ? undefined : rules.guarantor.grades.find((g) => total >= g.minTotal);
  const grade = band ?? rules.guarantor.fallback;
  return { ...t, grade: grade.grade, gradeLabel: grade.label, weight: grade.weight };
}

/**
 * The amount level (doc 03 §4) of the amount it is given. The caller gives the final
 * approved amount once there is one, so a reduced amount is levelled again (doc 03 §4;
 * this corrects EXCEL-BUG-4, where the workbook levels only the requested amount B7).
 */
export function amountLevelOf(
  rules: ScoringRuleset,
  amountRial: bigint,
): { level: string; label: string } {
  if (amountRial < 0n) throw new ScoringInputError('a negative amount');
  const level = rules.amountLevels.levels.find((l) => amountRial <= BigInt(l.upToRial));
  return level ?? rules.amountLevels.overCap;
}

function holds(
  rule: Extract<ScoringSufficiencyRule, { kind: 'weights' }>,
  [first, second]: readonly [number, number],
) {
  const stat = {
    max: Math.max(first, second),
    min: Math.min(first, second),
    sum: first + second,
  };
  return rule.anyOf.some((group) => group.every((test) => stat[test.stat] >= test.atLeast));
}

/**
 * Doc 03 §1 steps 1–6 on answers (options): scores, grades, level, required guarantee,
 * sufficiency of the guarantors, and who decides. The same as the client's workbook on
 * every golden case.
 */
export function evaluate(
  rules: ScoringRuleset,
  answers: ScoringAnswers,
  amountRial: bigint | null,
): ScoringOutcome {
  const borrower = borrowerOutcome(rules, answers.borrower);
  const guarantors = [
    guarantorOutcome(rules, answers.guarantors[0], 'guarantor1'),
    guarantorOutcome(rules, answers.guarantors[1], 'guarantor2'),
  ] as const;
  const amountLevel = amountRial === null ? null : amountLevelOf(rules, amountRial);

  if (borrower.grade === null || amountLevel === null) {
    return {
      amountLevel,
      borrower,
      guarantors,
      requirement: null,
      sufficiency: { outcome: 'incomplete', label: rules.sufficiencyLabels.incomplete },
      authority: null,
    };
  }
  const overCap = amountLevel.level === rules.amountLevels.overCap.level;
  const cell = rules.matrix.find(
    (m) => m.grade === borrower.grade && m.level === amountLevel.level,
  );

  // Beyond the cap is checked before a rejecting grade, as the workbook does (B19).
  const requirement = overCap
    ? { label: rules.requirementLabels.overCap, twoGuarantors: false }
    : borrower.reject
      ? { label: rules.requirementLabels.reject, twoGuarantors: false }
      : cell
        ? { label: cell.requirement, twoGuarantors: cell.twoGuarantors }
        : null;
  if (requirement === null) throw new ScoringInputError('the matrix has no such cell');

  let sufficiency: ScoringOutcome['sufficiency'];
  if (borrower.reject || overCap || !cell) {
    sufficiency = { outcome: 'not_reviewable', label: rules.sufficiencyLabels.notReviewable };
  } else if (cell.sufficiency.kind === 'not_required') {
    sufficiency = { outcome: 'not_required', label: cell.sufficiency.label };
  } else if (cell.sufficiency.kind === 'reject') {
    sufficiency = { outcome: 'reject', label: cell.sufficiency.label };
  } else {
    // EXCEL-BUG-1: two guarantors sharing an income source still count as two; the
    // workbook asks it (B32) and never uses it. EXCEL-BUG-2: an excellent and a
    // supplementary guarantor never satisfy a two-guarantor cell; that is in the data.
    const ok = holds(cell.sufficiency, [guarantors[0].weight, guarantors[1].weight]);
    sufficiency = ok
      ? { outcome: 'sufficient', label: cell.sufficiency.passLabel }
      : { outcome: 'insufficient', label: cell.sufficiency.failLabel };
  }

  // EXCEL-BUG-3 (every «زیاد» goes to the committee, though the matrix names the credit
  // manager for الف and ب) and EXCEL-BUG-8 (beyond the cap with الف or ب matches no rule
  // and falls to the specialist, though doc 03 §4 sends it to the committee) are the
  // workbook's B27, kept in the rules' order and not corrected (owner, 1405/07/10).
  let authority: ScoringOutcome['authority'];
  if (borrower.reject || borrower.stop === true) {
    authority = {
      authority: rules.authority.reject.authority,
      label: rules.authority.reject.label,
    };
  } else {
    const rule = rules.authority.rules.find(
      (r) =>
        (r.levels === undefined || r.levels.includes(amountLevel.level)) &&
        (r.grades === undefined || r.grades.includes(borrower.grade ?? '')) &&
        (r.twoGuarantors === undefined || requirement.twoGuarantors),
    );
    authority = rule
      ? { authority: rule.authority, label: rule.label }
      : { authority: rules.authority.fallback.authority, label: rules.authority.fallback.label };
  }

  return { amountLevel, borrower, guarantors, requirement, sufficiency, authority };
}

// --- raw data → options (doc 03 §8-1: the specialist enters raw data, not a band) -------

export interface RawBorrowerData {
  readonly job?: string | undefined;
  readonly employmentStartedOn?: JalaliDate | undefined;
  /** EXCEL-BUG-5: «pay coverage / allowed days» merges two measures; chosen as an option. */
  readonly coverage?: string | undefined;
  readonly obligationsRial?: bigint | undefined;
  readonly newInstallmentRial?: bigint | undefined;
}
export interface RawGuarantorData {
  readonly job?: string | undefined;
  readonly employmentStartedOn?: JalaliDate | undefined;
  readonly averageBalanceRial?: bigint | undefined;
  readonly installmentRial?: bigint | undefined;
  readonly debts?: string | undefined;
  /** EXCEL-BUG-7: «fully independent» is a valid option here, whatever the dropdown. */
  readonly independence?: string | undefined;
}
export interface RawScoringData {
  readonly borrower: RawBorrowerData;
  readonly guarantors: readonly RawGuarantorData[];
}

/** Whole Jalali years from `from` to `to` (an anniversary not yet reached does not count). */
export function completedJalaliYears(from: JalaliDate, to: JalaliDate): number {
  if (compareJalali(from, to) > 0)
    throw new ScoringInputError('employment starts after the review');
  const before = to.month < from.month || (to.month === from.month && to.day < from.day);
  return to.year - from.year - (before ? 1 : 0);
}

function tenureOption(rules: ScoringRuleset, from: JalaliDate, reviewedOn: JalaliDate) {
  const years = completedJalaliYears(from, reviewedOn);
  return (
    rules.raw.tenure.bands.find((b) => years >= b.minYears)?.option ?? rules.raw.tenure.otherwise
  );
}

/** a ÷ b ≤ num/den, in whole rials, without fractions. */
const atMost = (a: bigint, b: bigint, r: { num: number; den: number }) =>
  a * BigInt(r.den) <= BigInt(r.num) * b;
const atLeast = (a: bigint, b: bigint, r: { num: number; den: number }) =>
  a * BigInt(r.den) >= BigInt(r.num) * b;

function positive(value: bigint, what: string) {
  if (value <= 0n) throw new ScoringInputError(`${what} must be more than zero`);
  return value;
}

/** Raw data to the options the rules score; what is missing stays unanswered. */
export function classify(
  rules: ScoringRuleset,
  raw: RawScoringData,
  reviewedOn: JalaliDate,
): ScoringAnswers {
  if (raw.guarantors.length > 2) throw new ScoringInputError('at most two guarantors');
  const b = raw.borrower;
  const borrower: Record<string, string> = {};
  if (b.job !== undefined) borrower['job'] = b.job;
  if (b.employmentStartedOn !== undefined) {
    borrower[rules.raw.tenure.criterion] = tenureOption(rules, b.employmentStartedOn, reviewedOn);
  }
  if (b.coverage !== undefined) borrower['coverage'] = b.coverage;
  if (b.obligationsRial !== undefined && b.newInstallmentRial !== undefined) {
    const installment = positive(b.newInstallmentRial, 'the new installment');
    const owed = b.obligationsRial;
    if (owed < 0n) throw new ScoringInputError('negative obligations');
    const { obligations } = rules.raw;
    borrower[obligations.criterion] =
      obligations.bands.find((band) => atMost(owed, installment, band.atMost))?.option ??
      obligations.otherwise;
  }

  const guarantor = (g: RawGuarantorData | undefined): ScoringAnswerSet | null => {
    if (g === undefined) return null;
    const out: Record<string, string> = {};
    if (g.job !== undefined) out['job'] = g.job;
    if (g.employmentStartedOn !== undefined) {
      out[rules.raw.tenure.criterion] = tenureOption(rules, g.employmentStartedOn, reviewedOn);
    }
    if (g.averageBalanceRial !== undefined && g.installmentRial !== undefined) {
      const installment = positive(g.installmentRial, 'the installment');
      const balance = g.averageBalanceRial;
      if (balance < 0n) throw new ScoringInputError('a negative balance');
      const { guarantorCoverage } = rules.raw;
      out[guarantorCoverage.criterion] =
        guarantorCoverage.bands.find((band) => atLeast(balance, installment, band.atLeast))
          ?.option ?? guarantorCoverage.otherwise;
    }
    if (g.debts !== undefined) out['debts'] = g.debts;
    if (g.independence !== undefined) out['independence'] = g.independence;
    return out;
  };

  return { borrower, guarantors: [guarantor(raw.guarantors[0]), guarantor(raw.guarantors[1])] };
}

/** Doc 10 §5: score(rulesetVersion, rawInputs) — the options it chose and the outcome. */
export function score(
  rules: ScoringRuleset,
  raw: RawScoringData,
  amountRial: bigint,
  reviewedOn: JalaliDate,
): { answers: ScoringAnswers; outcome: ScoringOutcome } {
  const answers = classify(rules, raw, reviewedOn);
  return { answers, outcome: evaluate(rules, answers, amountRial) };
}
