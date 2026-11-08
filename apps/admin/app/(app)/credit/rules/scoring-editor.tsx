'use client';

import {
  runGoldenCases,
  toPersianDigits,
  type GoldenFile,
  type JalaliDate,
  type ScoringRuleset,
} from '@sepehr/contracts';
import { buttonClass, inputClass, MoneyField, Notice } from '@sepehr/ui';
import { useState, type ReactNode } from 'react';
import {
  authorityChoices,
  goldenText,
  PARTY_LABEL,
  rialText,
  scoringChanges,
  scoringProblems,
  setAuthority,
  setGradeMinimum,
  setLevelCeiling,
  setOptionLabel,
  setOptionScore,
  type AuthorityCode,
  type Party,
} from '../../../../lib/scoring-editor';
import { ProposalForm } from './proposal-form';
import { RawJson, Tabs } from './editor-parts';

const fa = (n: number | string) => toPersianDigits(String(n));
const yesNo = (b: boolean) => (b ? 'بله' : 'خیر');
const cell = 'border-b border-border px-2 py-1 align-top';

function Table({
  caption,
  head,
  children,
}: {
  caption: string;
  head: string[];
  children: ReactNode;
}) {
  return (
    <table className="w-full border-collapse text-[length:var(--text-sm)]">
      <caption className="pb-2 text-start font-bold">{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col" className={`${cell} text-start`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

interface Review {
  readonly value: ScoringRuleset;
  readonly changes: string[];
  readonly problems: string[];
}

/**
 * The scoring rules (`credit.scoring_ruleset`) as tables (owner 1405/08/10): each option's label
 * and score, each grade's minimum, each amount level's ceiling and each rule's authority. Codes
 * and everything else stay as stored; «نمایش تغییرات» says the change in Persian and runs the
 * workbook's golden cases before anything is sent, then one strategy manager proposes and
 * another approves, as before.
 */
export function ScoringEditor({
  current,
  mayEdit,
  today,
}: {
  current: ScoringRuleset;
  mayEdit: boolean;
  today: JalaliDate;
}) {
  const [draft, setDraft] = useState(current);
  const [review, setReview] = useState<Review | null>(null);
  const [checking, setChecking] = useState(false);
  const change = (next: ScoringRuleset) => {
    setDraft(next);
    setReview(null);
  };
  const choices = authorityChoices(current);
  const levelLabel = (code: string) =>
    [...current.amountLevels.levels, current.amountLevels.overCap].find((l) => l.level === code)
      ?.label ?? code;
  const gradeLabel = (code: string) =>
    [...current.borrower.grades, current.borrower.fallback].find((g) => g.grade === code)?.label ??
    code;

  const party = (who: Party) => {
    const p = draft[who];
    return (
      <div className="space-y-6">
        {p.criteria.map((c, ci) => (
          <Table
            key={c.code}
            caption={`${PARTY_LABEL[who]} › ${c.label}`}
            head={['کد گزینه', 'برچسب', 'امتیاز', 'توقف']}
          >
            {c.options.map((o, oi) => (
              <tr key={o.code}>
                <td className={cell} dir="ltr">
                  {o.code}
                </td>
                <td className={cell}>
                  <input
                    aria-label={`برچسب ${o.code} در ${c.label} (${PARTY_LABEL[who]})`}
                    className={inputClass}
                    defaultValue={o.label}
                    disabled={!mayEdit}
                    onChange={(e) => {
                      change(setOptionLabel(draft, who, ci, oi, e.target.value));
                    }}
                  />
                </td>
                <td className={`${cell} w-28`}>
                  <input
                    aria-label={`امتیاز ${o.code} در ${c.label} (${PARTY_LABEL[who]})`}
                    className={`${inputClass} figures`}
                    inputMode="numeric"
                    defaultValue={Number.isFinite(o.score) ? fa(o.score) : ''}
                    disabled={!mayEdit}
                    onChange={(e) => {
                      change(setOptionScore(draft, who, ci, oi, e.target.value));
                    }}
                  />
                </td>
                <td className={cell}>{yesNo(o.stop)}</td>
              </tr>
            ))}
          </Table>
        ))}
        <Table
          caption={`رتبه‌های ${PARTY_LABEL[who]} (از بالا به پایین)`}
          head={['رتبه', 'حداقل امتیاز', who === 'borrower' ? 'تفسیر' : 'وزن', 'رد']}
        >
          {p.grades.map((g, gi) => (
            <tr key={g.grade}>
              <td className={cell}>{g.label}</td>
              <td className={`${cell} w-28`}>
                <input
                  aria-label={`حداقل امتیاز رتبه ${g.label} (${PARTY_LABEL[who]})`}
                  className={`${inputClass} figures`}
                  inputMode="numeric"
                  defaultValue={Number.isFinite(g.minTotal) ? fa(g.minTotal) : ''}
                  disabled={!mayEdit}
                  onChange={(e) => {
                    change(setGradeMinimum(draft, who, gi, e.target.value));
                  }}
                />
              </td>
              <td className={cell}>
                {'interpretation' in g ? g.interpretation : fa((g as { weight: number }).weight)}
              </td>
              <td className={cell}>{'reject' in g ? yesNo(g.reject) : '—'}</td>
            </tr>
          ))}
          <tr>
            <td className={cell}>{p.fallback.label}</td>
            <td className={cell}>زیر همه رتبه‌ها یا توقف</td>
            <td className={cell}>
              {'interpretation' in p.fallback
                ? p.fallback.interpretation
                : fa((p.fallback as { weight: number }).weight)}
            </td>
            <td className={cell}>{'reject' in p.fallback ? yesNo(p.fallback.reject) : '—'}</td>
          </tr>
        </Table>
      </div>
    );
  };

  const condition = (rule: ScoringRuleset['authority']['rules'][number]) =>
    [
      rule.levels ? `سطح مبلغ ${rule.levels.map(levelLabel).join(' یا ')}` : null,
      rule.grades ? `رتبه ${rule.grades.map(gradeLabel).join(' یا ')}` : null,
      rule.twoGuarantors ? 'الزام دو ضامن' : null,
    ]
      .filter(Boolean)
      .join(' و ');

  const authoritySelect = (label: string, value: string, rule: number | 'fallback') => (
    <select
      aria-label={label}
      className={inputClass}
      value={value}
      disabled={!mayEdit}
      onChange={(e) => {
        change(setAuthority(draft, rule, e.target.value as AuthorityCode));
      }}
    >
      {choices.map((c) => (
        <option key={c.code} value={c.code}>
          {c.label}
        </option>
      ))}
    </select>
  );

  const tabs = [
    { id: 'borrower', label: 'وام‌گیرنده', body: party('borrower') },
    { id: 'guarantor', label: 'ضامن', body: party('guarantor') },
    {
      id: 'levels',
      label: 'سطح مبلغ',
      body: (
        <Table caption="سطح‌های مبلغ (صعودی)" head={['سطح', 'سقف', 'یعنی']}>
          {draft.amountLevels.levels.map((l, li) => (
            <tr key={l.level}>
              <td className={cell}>{l.label}</td>
              <td className={cell}>
                {mayEdit ? (
                  <MoneyField
                    id={`level-${l.level}`}
                    name={`level-${l.level}`}
                    label={`سقف سطح ${l.label}`}
                    defaultValue={current.amountLevels.levels[li]?.upToRial ?? ''}
                    onChange={(rial) => {
                      change(setLevelCeiling(draft, li, rial));
                    }}
                  />
                ) : (
                  fa(l.upToRial)
                )}
              </td>
              <td className={cell}>{rialText(l.upToRial)}</td>
            </tr>
          ))}
          <tr>
            <td className={cell}>{draft.amountLevels.overCap.label}</td>
            <td className={cell}>بیش از سقف بالاترین سطح</td>
            <td className={cell}>—</td>
          </tr>
        </Table>
      ),
    },
    {
      id: 'authority',
      label: 'مرجع تصمیم',
      body: (
        <Table caption="مرجع تصمیم (اولین قاعده‌ای که برقرار باشد)" head={['ترتیب', 'شرط', 'مرجع']}>
          <tr>
            <td className={cell}>—</td>
            <td className={cell}>رد یا توقف</td>
            <td className={cell}>{draft.authority.reject.label}</td>
          </tr>
          {draft.authority.rules.map((r, ri) => (
            <tr key={`${String(ri)}-${condition(r)}`}>
              <td className={cell}>{fa(ri + 1)}</td>
              <td className={cell}>{condition(r)}</td>
              <td className={cell}>
                {authoritySelect(`مرجع قاعده ${fa(ri + 1)}`, r.authority, ri)}
              </td>
            </tr>
          ))}
          <tr>
            <td className={cell}>—</td>
            <td className={cell}>در غیر این صورت</td>
            <td className={cell}>
              {authoritySelect('مرجع پیش‌فرض', draft.authority.fallback.authority, 'fallback')}
            </td>
          </tr>
        </Table>
      ),
    },
    {
      id: 'matrix',
      label: 'ماتریس کفایت (فقط نمایش)',
      body: (
        <Table
          caption="ماتریس کفایت ضمانت (فقط نمایش)"
          head={['رتبه', 'سطح مبلغ', 'الزام ضمانت', 'دو ضامن', 'کفایت']}
        >
          {draft.matrix.map((m) => (
            <tr key={`${m.grade}-${m.level}`}>
              <td className={cell}>{gradeLabel(m.grade)}</td>
              <td className={cell}>{levelLabel(m.level)}</td>
              <td className={cell}>{m.requirement}</td>
              <td className={cell}>{yesNo(m.twoGuarantors)}</td>
              <td className={cell}>
                {m.sufficiency.kind === 'weights'
                  ? `${m.sufficiency.passLabel} / ${m.sufficiency.failLabel}`
                  : m.sufficiency.label}
              </td>
            </tr>
          ))}
        </Table>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <section
        aria-label="درباره این نسخه"
        className="space-y-2 rounded-lg border border-border bg-surface p-4 text-[length:var(--text-sm)]"
      >
        <p>
          نسخه قواعد: <strong>{fa(current.version)}</strong>
        </p>
        <p>منبع: {current.source}</p>
        <details>
          <summary>خطاهای شناخته‌شده فایل اکسل ({fa(current.excelBugs.length)})، فقط نمایش</summary>
          <ul className="list-disc space-y-1 ps-6">
            {current.excelBugs.map((b) => (
              <li key={b.id}>
                <span dir="ltr">{b.id}</span>: {b.note}
              </li>
            ))}
          </ul>
        </details>
        <Notice tone="info">
          قواعد پیش از پیشنهاد و دوباره پیش از تأیید با همه موردهای نمونه فایل اکسل کارفرما سنجیده
          می‌شوند؛ هر تغییری که نتیجه یکی از آن‌ها را عوض کند، پذیرفته نمی‌شود (سند ۰۳ §۸-۳). برچسب
          گزینه‌ها در این سنجش نیست.
        </Notice>
      </section>
      <Tabs label="بخش‌های قواعد امتیاز" tabs={tabs} />
      {mayEdit && (
        <button
          type="button"
          className={buttonClass('secondary')}
          disabled={checking}
          onClick={() => {
            const value = draft;
            setChecking(true);
            void import('@sepehr/contracts/fixtures/scoring/golden-v1.json')
              .then((m) => {
                const cases = m.default as unknown as GoldenFile;
                const own = scoringProblems(value);
                // The API refuses rules that break a golden case: said here, not sent.
                const golden =
                  own.length === 0
                    ? goldenText(runGoldenCases(value, cases), cases.cases.length)
                    : null;
                setReview({
                  value,
                  changes: scoringChanges(current, value),
                  problems: golden ? [...own, golden] : own,
                });
              })
              .finally(() => {
                setChecking(false);
              });
          }}
        >
          نمایش تغییرات
        </button>
      )}
      {review && (
        <ProposalForm
          configKey="credit.scoring_ruleset"
          value={review.value}
          changes={review.changes}
          problems={review.problems}
          today={today}
        />
      )}
      <RawJson value={current} />
    </div>
  );
}
