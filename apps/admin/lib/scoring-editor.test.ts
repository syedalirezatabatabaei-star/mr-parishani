import {
  runGoldenCases,
  scoringRulesetSchema,
  type GoldenFile,
  type ScoringRuleset,
} from '@sepehr/contracts';
import golden from '@sepehr/contracts/fixtures/scoring/golden-v1.json';
import v1 from '@sepehr/contracts/fixtures/scoring/ruleset-v1.json';
import { describe, expect, it } from 'vitest';
import { sameJson } from './config-diff';
import {
  authorityChoices,
  goldenText,
  scoringChanges,
  scoringProblems,
  setAuthority,
  setGradeMinimum,
  setLevelCeiling,
  setOptionLabel,
  setOptionScore,
} from './scoring-editor';

const rules = (): ScoringRuleset => scoringRulesetSchema.parse(structuredClone(v1));
const cases = golden as unknown as GoldenFile;

describe('the scoring rules form (owner 1405/08/10)', () => {
  it('gives back exactly the JSON it was given when nothing, or the same value, is typed', () => {
    const r = rules();
    // The client's version 1 is already the schema's shape: parsing keeps it as it is.
    expect(sameJson(r, v1)).toBe(true);
    const first = r.borrower.criteria[0]?.options[0];
    const grade = r.guarantor.grades[1];
    const level = r.amountLevels.levels[2];
    if (!first || !grade || !level) throw new Error('fixture');
    let same = setOptionScore(
      r,
      'borrower',
      0,
      0,
      String(first.score).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d),
    );
    same = setOptionLabel(same, 'borrower', 0, 0, first.label);
    same = setGradeMinimum(same, 'guarantor', 1, String(grade.minTotal));
    same = setLevelCeiling(same, 2, BigInt(level.upToRial));
    same = setAuthority(same, 0, 'committee');
    expect(sameJson(same, v1)).toBe(true);
    expect(scoringChanges(r, same)).toEqual([]);
    expect(scoringProblems(same)).toEqual([]);
  });

  it('changes only the field edited, and says so in Persian', () => {
    const r = rules();
    const edited = setOptionScore(r, 'borrower', 0, 1, '۲۵');
    const option = r.borrower.criteria[0]?.options[1];
    expect(edited.borrower.criteria[0]?.options[1]?.score).toBe(25);
    expect(scoringChanges(r, edited)).toEqual([
      `وام‌گیرنده › ${r.borrower.criteria[0]?.label ?? ''} › «${option?.label ?? ''}»: امتیاز از ${String(option?.score).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d)} به ۲۵`,
    ]);
    // The rest of the value is untouched.
    const back = structuredClone(edited);
    const o = back.borrower.criteria[0]?.options[1];
    if (o && option) o.score = option.score;
    expect(sameJson(back, v1)).toBe(true);
  });

  it('moves an authority with its label, said once', () => {
    const r = rules();
    const edited = setAuthority(r, 2, 'committee');
    expect(edited.authority.rules[2]).toMatchObject({
      authority: 'committee',
      label: 'کمیته ریسک و اعتبار',
    });
    expect(scoringChanges(r, edited)).toEqual([
      'قاعده ۳ مرجع تصمیم: از «مسئول / مدیر اعتبار» به «کمیته ریسک و اعتبار»',
    ]);
    expect(authorityChoices(r).map((c) => c.label)).toEqual([
      'کارشناس اعتبار + کنترل دوم',
      'مسئول / مدیر اعتبار',
      'کمیته ریسک و اعتبار',
    ]);
  });

  it('refuses in Persian what the schema refuses: scores, grade order, level order, labels', () => {
    const r = rules();
    expect(scoringProblems(setOptionScore(r, 'borrower', 0, 0, '101'))[0]).toMatch(
      /امتیاز باید عدد صحیح از ۰ تا ۱۰۰ باشد/,
    );
    expect(scoringProblems(setOptionScore(r, 'borrower', 0, 0, 'ده'))).toHaveLength(1);
    expect(scoringProblems(setGradeMinimum(r, 'borrower', 1, '80'))[0]).toMatch(
      /^رتبه‌های وام‌گیرنده: حداقل امتیاز باید از رتبه بالا به پایین کم شود/,
    );
    expect(scoringProblems(setGradeMinimum(r, 'guarantor', 0, '50'))[0]).toMatch(/هم‌پوشانی/);
    expect(scoringProblems(setLevelCeiling(r, 1, 30_000_000n))).toEqual([
      'سطح‌های مبلغ: سقف هر سطح باید از سطح قبلی بیشتر باشد (ترتیب صعودی).',
    ]);
    expect(scoringProblems(setLevelCeiling(r, 0, null))[0]).toMatch(/به ریال و بیش از صفر/);
    expect(scoringProblems(setOptionLabel(r, 'guarantor', 1, 0, '  '))[0]).toMatch(/خالی/);
  });

  it('names a level in rials, tomans and millions', () => {
    const r = rules();
    expect(scoringChanges(r, setLevelCeiling(r, 0, 50_000_000n))).toEqual([
      'سطح مبلغ «کم»: سقف از ۴۰٬۰۰۰٬۰۰۰ ریال، ۴٬۰۰۰٬۰۰۰ تومان (۴ میلیون تومان) به ۵۰٬۰۰۰٬۰۰۰ ریال، ۵٬۰۰۰٬۰۰۰ تومان (۵ میلیون تومان)',
    ]);
  });

  it('tells before sending whether the workbook’s golden cases still hold', () => {
    const r = rules();
    expect(runGoldenCases(r, cases)).toEqual([]);
    expect(goldenText([], cases.cases.length)).toBeNull();
    // An option label is not part of what Excel showed: the cases still hold.
    expect(runGoldenCases(setOptionLabel(r, 'borrower', 0, 0, 'برچسب تازه'), cases)).toEqual([]);
    const failures = runGoldenCases(setOptionScore(r, 'borrower', 0, 0, '0'), cases);
    expect(failures.length).toBeGreaterThan(0);
    expect(goldenText(failures, cases.cases.length)).toMatch(/سامانه چنین قواعدی را نمی‌پذیرد/);
  });
});
