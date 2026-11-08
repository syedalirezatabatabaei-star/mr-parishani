import {
  formatRial,
  formatToman,
  normalizeDigits,
  scoringRulesetSchema,
  toPersianDigits,
  type GoldenFailure,
  type ScoringRuleset,
} from '@sepehr/contracts';
import { diffJson, type Change } from './config-diff';

/**
 * The scoring rules (`credit.scoring_ruleset`) as a form (owner 1405/08/10). Only what the owner
 * named is editable: each option's label and score, each grade's minimum, each amount level's
 * ceiling and each decision rule's authority. Codes, the matrix, the raw bands, the workbook's
 * errors, the source and the version stay as they are, so a value nobody edited goes back
 * exactly as it came. Every edit returns a new value; the server checks it all again.
 */

export type Party = 'borrower' | 'guarantor';
export const PARTY_LABEL: Readonly<Record<Party, string>> = {
  borrower: 'وام‌گیرنده',
  guarantor: 'ضامن',
};

/** The authorities a decision rule may name (doc 03 §6); a rejection's is not chosen here. */
export const AUTHORITY_CODES = ['expert_second_check', 'credit_manager', 'committee'] as const;
export type AuthorityCode = (typeof AUTHORITY_CODES)[number];
const AUTHORITY_DEFAULT_LABEL: Readonly<Record<AuthorityCode, string>> = {
  expert_second_check: 'کارشناس اعتبار + کنترل دوم',
  credit_manager: 'مسئول / مدیر اعتبار',
  committee: 'کمیته ریسک و اعتبار',
};

/** Each authority with the label the rules already give it, so a changed rule reads the same. */
export function authorityChoices(r: ScoringRuleset): { code: AuthorityCode; label: string }[] {
  const named = new Map<string, string>();
  for (const a of [...r.authority.rules, r.authority.fallback]) {
    if (!named.has(a.authority)) named.set(a.authority, a.label);
  }
  return AUTHORITY_CODES.map((code) => ({
    code,
    label: named.get(code) ?? AUTHORITY_DEFAULT_LABEL[code],
  }));
}

/** A whole number as typed, in any digits; NaN for anything else (refused by `problems`). */
function wholeNumber(typed: string): number {
  const text = normalizeDigits(typed).trim();
  return /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN;
}

const edit = (r: ScoringRuleset, change: (draft: ScoringRuleset) => void): ScoringRuleset => {
  const draft = structuredClone(r);
  change(draft);
  return draft;
};

export const setOptionScore = (
  r: ScoringRuleset,
  party: Party,
  criterion: number,
  option: number,
  typed: string,
) =>
  edit(r, (d) => {
    const o = d[party].criteria[criterion]?.options[option];
    if (o) o.score = wholeNumber(typed);
  });

export const setOptionLabel = (
  r: ScoringRuleset,
  party: Party,
  criterion: number,
  option: number,
  label: string,
) =>
  edit(r, (d) => {
    const o = d[party].criteria[criterion]?.options[option];
    if (o) o.label = label;
  });

export const setGradeMinimum = (r: ScoringRuleset, party: Party, grade: number, typed: string) =>
  edit(r, (d) => {
    const g = d[party].grades[grade];
    if (g) g.minTotal = wholeNumber(typed);
  });

/** A level's ceiling in whole rials; '' when what was typed is no amount. */
export const setLevelCeiling = (r: ScoringRuleset, level: number, rial: bigint | null) =>
  edit(r, (d) => {
    const l = d.amountLevels.levels[level];
    if (l) l.upToRial = rial === null || rial <= 0n ? '' : rial.toString();
  });

/** A rule's authority (an index of `authority.rules`, or its fallback), with that label. */
export const setAuthority = (r: ScoringRuleset, rule: number | 'fallback', code: AuthorityCode) =>
  edit(r, (d) => {
    const label = authorityChoices(r).find((c) => c.code === code)?.label ?? code;
    const target = rule === 'fallback' ? d.authority.fallback : d.authority.rules[rule];
    if (target) {
      target.authority = code;
      target.label = label;
    }
  });

const fa = (n: number | string) => toPersianDigits(String(n));
const isScore = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100;

/** Whatever keeps the value from being proposed, in plain Persian; empty when it may be. */
export function scoringProblems(r: ScoringRuleset): string[] {
  const out: string[] = [];
  for (const party of ['borrower', 'guarantor'] as const) {
    const who = PARTY_LABEL[party];
    for (const c of r[party].criteria) {
      c.options.forEach((o, i) => {
        if (o.label.trim() === '' || o.label.length > 300) {
          out.push(`${who} › ${c.label}: برچسب گزینه ${fa(i + 1)} خالی یا بیش از ۳۰۰ نویسه است.`);
        }
        if (!isScore(o.score)) {
          out.push(`${who} › ${c.label} › «${o.label}»: امتیاز باید عدد صحیح از ۰ تا ۱۰۰ باشد.`);
        }
      });
    }
    const mins = r[party].grades.map((g) => g.minTotal);
    if (!mins.every(isScore)) {
      out.push(`رتبه‌های ${who}: حداقل امتیاز هر رتبه باید عدد صحیح از ۰ تا ۱۰۰ باشد.`);
    } else if (mins.some((m, i) => i > 0 && m >= (mins[i - 1] ?? 0))) {
      out.push(
        `رتبه‌های ${who}: حداقل امتیاز باید از رتبه بالا به پایین کم شود و دو رتبه هم‌پوشانی نداشته باشند (${r[
          party
        ].grades
          .map((g) => `«${g.label}» ${fa(g.minTotal)}`)
          .join('، ')}).`,
      );
    }
  }
  const ceilings = r.amountLevels.levels.map((l) => l.upToRial);
  if (ceilings.some((c) => !/^[1-9][0-9]{0,17}$/.test(c))) {
    out.push('سطح‌های مبلغ: سقف هر سطح را به ریال و بیش از صفر بنویسید.');
  } else if (ceilings.some((c, i) => i > 0 && BigInt(c) <= BigInt(ceilings[i - 1] ?? '0'))) {
    out.push('سطح‌های مبلغ: سقف هر سطح باید از سطح قبلی بیشتر باشد (ترتیب صعودی).');
  }
  if (out.length === 0) {
    const parsed = scoringRulesetSchema.safeParse(r);
    if (!parsed.success) {
      out.push(
        `قواعد با قالب سامانه نمی‌خواند: ${parsed.error.issues
          .map((i) => i.path.join('.') || i.message)
          .join('، ')}`,
      );
    }
  }
  return out;
}

/** An amount in rials, with its tomans and, when round, its millions of tomans. */
export function rialText(rial: string): string {
  if (!/^[0-9]+$/.test(rial)) return '—';
  const toman = BigInt(rial) / 10n;
  const millions =
    toman % 1_000_000n === 0n ? ` (${fa(String(toman / 1_000_000n))} میلیون تومان)` : '';
  return `${formatRial(rial)}، ${formatToman(rial)}${millions}`;
}

/** One change in plain Persian: where it is, and from what to what. */
function describe(before: ScoringRuleset, change: Change): string | null {
  const [head, ...rest] = change.path;
  const was = change.before;
  const now = change.after;
  if ((head === 'borrower' || head === 'guarantor') && rest[0] === 'criteria') {
    const c = before[head].criteria[Number(rest[1])];
    const o = c?.options[Number(rest[3])];
    if (c && o && rest[2] === 'options') {
      const where = `${PARTY_LABEL[head]} › ${c.label} › «${o.label}»`;
      if (rest[4] === 'score')
        return `${where}: امتیاز از ${fa(String(was))} به ${fa(String(now))}`;
      if (rest[4] === 'label') return `${where}: برچسب به «${String(now)}»`;
    }
  }
  if ((head === 'borrower' || head === 'guarantor') && rest[0] === 'grades') {
    const g = before[head].grades[Number(rest[1])];
    if (g && rest[2] === 'minTotal') {
      return `رتبه «${g.label}» ${PARTY_LABEL[head]}: حداقل امتیاز از ${fa(String(was))} به ${fa(String(now))}`;
    }
  }
  if (head === 'amountLevels' && rest[0] === 'levels' && rest[2] === 'upToRial') {
    const l = before.amountLevels.levels[Number(rest[1])];
    return `سطح مبلغ «${l?.label ?? ''}»: سقف از ${rialText(String(was))} به ${rialText(String(now))}`;
  }
  if (head === 'authority') {
    // The label moves with the authority: one line, said once.
    if (rest[rest.length - 1] === 'label') return null;
    const which =
      rest[0] === 'fallback' ? 'مرجع پیش‌فرض' : `قاعده ${fa(Number(rest[1]) + 1)} مرجع تصمیم`;
    const label = (code: unknown) =>
      authorityChoices(before).find((c) => c.code === code)?.label ?? String(code);
    return `${which}: از «${label(was)}» به «${label(now)}»`;
  }
  return `${change.path.join(' › ')}: از ${JSON.stringify(was)} به ${JSON.stringify(now)}`;
}

/** Every change between the rules in force and the edited ones, in plain Persian. */
export function scoringChanges(before: ScoringRuleset, after: ScoringRuleset): string[] {
  return diffJson(before, after)
    .map((c) => describe(before, c))
    .filter((line): line is string => line !== null);
}

/** What the golden cases of the client's workbook say about the edited rules (doc 03 §8-3). */
export function goldenText(failures: readonly GoldenFailure[], of: number): string | null {
  if (failures.length === 0) return null;
  const cases = new Set(failures.map((f) => f.id)).size;
  return `با این قواعد، ${fa(cases)} مورد از ${fa(of)} مورد نمونه فایل اکسل کارفرما نتیجه دیگری می‌گیرد؛ سامانه چنین قواعدی را نمی‌پذیرد (سند ۰۳ §۸-۳). نمونه: مورد ${failures[0]?.id ?? ''}، ${failures[0]?.field ?? ''}.`;
}
