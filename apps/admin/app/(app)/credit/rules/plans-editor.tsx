'use client';

import {
  formatRial,
  formatToman,
  toPersianDigits,
  type CreditPlans,
  type JalaliDate,
} from '@sepehr/contracts';
import { buttonClass, inputClass, MoneyField, Notice } from '@sepehr/ui';
import { useState, type ReactNode } from 'react';
import {
  addPlan,
  bpsToPercent,
  planChanges,
  planProblems,
  ruleText,
  samplePreview,
  setActive,
  setAmount,
  setCity,
  setClubOnly,
  setCounts,
  setDownPayment,
  setFields,
  setOfficerDiscount,
  setOriginationFee,
  setPlanFee,
  setTitle,
  setWageOnly,
  type Plan,
} from '../../../../lib/plan-editor';
import { RawJson } from './editor-parts';
import { ProposalForm } from './proposal-form';

const fa = (n: number | string | bigint) => toPersianDigits(String(n));
/** The counts offered; a plan's own counts are always offered too. */
const COUNTS = [3, 6, 9, 12, 18, 24, 36];
const label = 'block text-[length:var(--text-sm)] font-medium text-ink';

type Basis = 'percent' | 'fixed';
const amountOf = (rule: { basis: Basis; bps?: number; rial?: string }) =>
  rule.basis === 'percent'
    ? Number.isFinite(rule.bps)
      ? bpsToPercent(rule.bps ?? 0)
      : ''
    : (rule.rial ?? '');

function Field({ id, text, children }: { id: string; text: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={label}>
        {text}
      </label>
      {children}
    </div>
  );
}

interface Review {
  readonly value: CreditPlans;
  readonly changes: string[];
  readonly problems: string[];
}

/**
 * The loan plans (`credit.plans`) as forms (owner 1405/08/10): who each plan is for, its amounts,
 * down payment, fees, installment counts, wage-only (ADR-050) and the officers' discount
 * (ADR-048), with a sample installment table from the patient's own quote. A plan is turned
 * off, never removed; one strategy manager proposes the whole set and another approves it.
 */
export function PlansEditor({
  current,
  fields,
  cities,
  roundingUnitRial,
  today,
  mayEdit,
}: {
  current: CreditPlans;
  fields: readonly { code: string; name: string }[];
  cities: readonly { code: string; name: string }[];
  roundingUnitRial: string;
  today: JalaliDate;
  mayEdit: boolean;
}) {
  const [draft, setDraft] = useState(current);
  const [review, setReview] = useState<Review | null>(null);
  const [counts, setPreviewCounts] = useState<Record<string, number>>({});
  const change = (next: CreditPlans) => {
    setDraft(next);
    setReview(null);
  };
  const fieldName = (code: string) => fields.find((f) => f.code === code)?.name ?? code;

  const rule = (
    id: string,
    text: string,
    value: { basis: Basis; bps?: number; rial?: string },
    onChange: (basis: Basis, typed: string) => void,
    extra?: ReactNode,
  ) => (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 font-medium">{text}</legend>
      <div className="flex flex-wrap items-end gap-3">
        <Field id={`${id}-basis`} text="نوع">
          <select
            id={`${id}-basis`}
            className={inputClass}
            value={value.basis}
            disabled={!mayEdit}
            onChange={(e) => {
              onChange(e.target.value as Basis, '');
            }}
          >
            <option value="percent">درصد</option>
            <option value="fixed">مبلغ ثابت (ریال)</option>
          </select>
        </Field>
        <Field id={`${id}-amount`} text={value.basis === 'percent' ? 'درصد' : 'مبلغ (ریال)'}>
          <input
            key={value.basis}
            id={`${id}-amount`}
            className={`${inputClass} figures`}
            inputMode="decimal"
            defaultValue={amountOf(value)}
            disabled={!mayEdit}
            onChange={(e) => {
              onChange(value.basis, e.target.value);
            }}
          />
        </Field>
        {extra}
      </div>
      <p className="text-[length:var(--text-xs)] text-ink-muted">یعنی: {ruleText(value)}</p>
    </fieldset>
  );

  const form = (p: Plan, i: number) => {
    const id = `plan-${p.code}`;
    const offered = [...new Set([...COUNTS, ...p.installmentCounts])].sort((a, b) => a - b);
    const count = counts[p.code] ?? p.installmentCounts[0];
    const own = planProblems({ plans: [p] });
    const preview =
      own.length === 0 && count !== undefined
        ? samplePreview(p, count, BigInt(roundingUnitRial), new Date())
        : null;
    return (
      <fieldset disabled={!mayEdit} className="space-y-4">
        <legend className="sr-only">{p.title}</legend>
        <p className="text-[length:var(--text-sm)]">
          کد طرح: <span dir="ltr">{p.code}</span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-title`} text="نام طرح">
            <input
              id={`${id}-title`}
              className={inputClass}
              defaultValue={p.title}
              onChange={(e) => {
                change(setTitle(draft, i, e.target.value));
              }}
            />
          </Field>
          <Field id={`${id}-city`} text="شهر">
            <select
              id={`${id}-city`}
              className={inputClass}
              value={p.cityCode ?? ''}
              onChange={(e) => {
                change(setCity(draft, i, e.target.value === '' ? null : e.target.value));
              }}
            >
              <option value="">همه شهرها</option>
              {cities.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
              {p.cityCode !== null && !cities.some((c) => c.code === p.cityCode) && (
                <option value={p.cityCode}>{p.cityCode}</option>
              )}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={p.active}
            onChange={(e) => {
              change(setActive(draft, i, e.target.checked));
            }}
          />
          فعال (به بیمار پیشنهاد می‌شود)
        </label>
        <fieldset className="space-y-2">
          <legend className="font-medium">رشته‌های درمان</legend>
          <div className="flex flex-wrap gap-4">
            {[...new Set([...fields.map((f) => f.code), ...p.treatmentFieldCodes])].map((code) => (
              <label key={code} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={p.treatmentFieldCodes.includes(code)}
                  onChange={(e) => {
                    change(
                      setFields(
                        draft,
                        i,
                        e.target.checked
                          ? [...p.treatmentFieldCodes, code]
                          : p.treatmentFieldCodes.filter((c) => c !== code),
                      ),
                    );
                  }}
                />
                {fieldName(code)}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-[length:var(--text-sm)]">
          پزشکان:{' '}
          {p.doctorIds === null
            ? 'همه پزشکان این رشته‌ها'
            : `${fa(p.doctorIds.length)} پزشک مشخص (فقط نمایش؛ مدیر استراتژی فهرست پزشکان را نمی‌بیند)`}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyField
            id={`${id}-min`}
            name={`${id}-min`}
            label="کف مبلغ وام"
            defaultValue={p.minAmountRial}
            onChange={(rial) => {
              change(setAmount(draft, i, 'min', rial));
            }}
          />
          <MoneyField
            id={`${id}-max`}
            name={`${id}-max`}
            label="سقف مبلغ وام"
            defaultValue={p.maxAmountRial}
            onChange={(rial) => {
              change(setAmount(draft, i, 'max', rial));
            }}
          />
        </div>
        {rule(`${id}-down`, 'پیش‌پرداخت (درصد کل پیش‌فاکتور)', p.downPayment, (basis, typed) => {
          change(setDownPayment(draft, i, basis, typed));
        })}
        {rule(
          `${id}-fee`,
          'کارمزد طرح (درصد وام)',
          p.planFee,
          (basis, typed) => {
            change(setPlanFee(draft, i, basis, typed, p.planFee.timing));
          },
          <Field id={`${id}-fee-timing`} text="پرداخت">
            <select
              id={`${id}-fee-timing`}
              className={inputClass}
              value={p.planFee.timing}
              onChange={(e) => {
                change(
                  setPlanFee(
                    draft,
                    i,
                    p.planFee.basis,
                    amountOf(p.planFee),
                    e.target.value as Plan['planFee']['timing'],
                  ),
                );
              }}
            >
              <option value="spread">در اقساط</option>
              <option value="at_completion">نقد در تکمیل</option>
            </select>
          </Field>,
        )}
        {rule(
          `${id}-origination`,
          'هزینه تشکیل پرونده',
          p.originationFee,
          (basis, typed) => {
            change(
              setOriginationFee(
                draft,
                i,
                basis,
                typed,
                p.originationFee.basis === 'percent' ? p.originationFee.base : undefined,
              ),
            );
          },
          p.originationFee.basis === 'percent' ? (
            <Field id={`${id}-origination-base`} text="درصدِ">
              <select
                id={`${id}-origination-base`}
                className={inputClass}
                value={p.originationFee.base ?? 'loan'}
                onChange={(e) => {
                  change(
                    setOriginationFee(
                      draft,
                      i,
                      'percent',
                      amountOf(p.originationFee),
                      e.target.value as 'loan' | 'proforma',
                    ),
                  );
                }}
              >
                <option value="loan">مبلغ وام</option>
                <option value="proforma">کل پیش‌فاکتور</option>
              </select>
            </Field>
          ) : null,
        )}
        <fieldset className="space-y-2">
          <legend className="font-medium">تعداد اقساط</legend>
          <div className="flex flex-wrap gap-4">
            {offered.map((n) => (
              <label key={n} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={p.installmentCounts.includes(n)}
                  onChange={(e) => {
                    change(
                      setCounts(
                        draft,
                        i,
                        e.target.checked
                          ? [...p.installmentCounts, n]
                          : p.installmentCounts.filter((c) => c !== n),
                      ),
                    );
                  }}
                />
                {fa(n)} قسط
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={p.financeableBasis === 'wage'}
              onChange={(e) => {
                change(setWageOnly(draft, i, e.target.checked));
              }}
            />
            فقط دستمزد (مواد مصرفی نقد به پزشک؛ ADR-050)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={p.requiresClubMembership === true}
              onChange={(e) => {
                change(setClubOnly(draft, i, e.target.checked));
              }}
            />
            فقط اعضای باشگاه
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-discount`} text="سقف تخفیف مسئول تکمیل یا باشگاه (درصد؛ خالی: ندارد)">
            <input
              id={`${id}-discount`}
              className={`${inputClass} figures`}
              inputMode="decimal"
              defaultValue={
                p.originationOfficerDiscountBps === undefined
                  ? ''
                  : bpsToPercent(p.originationOfficerDiscountBps)
              }
              onChange={(e) => {
                change(setOfficerDiscount(draft, i, e.target.value));
              }}
            />
          </Field>
          <p className="text-[length:var(--text-sm)]">
            بخشودگی هزینه تشکیل با چک (فقط نمایش):{' '}
            {p.originationChequeWaiver
              ? `${bpsToPercent(p.originationChequeWaiver.bps)}٪ با دست‌کم ${fa(p.originationChequeWaiver.minCheques)} چک`
              : 'ندارد'}
          </p>
        </div>
        <section aria-label={`پیش‌نمایش ${p.title}`} className="space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <h3 className="font-bold">پیش‌نمایش روی پیش‌فاکتور نمونه ۱۰۰ میلیون تومانی</h3>
            {p.installmentCounts.length > 0 && (
              <select
                aria-label="تعداد قسط پیش‌نمایش"
                className={inputClass}
                value={count}
                disabled={false}
                onChange={(e) => {
                  setPreviewCounts({ ...counts, [p.code]: Number(e.target.value) });
                }}
              >
                {p.installmentCounts.map((n) => (
                  <option key={n} value={n}>
                    {fa(n)} قسط
                  </option>
                ))}
              </select>
            )}
          </div>
          {own.length > 0 ? (
            <Notice tone="warning">پیش‌نمایش پس از رفع ایرادهای این طرح ساخته می‌شود.</Notice>
          ) : typeof preview === 'string' ? (
            <Notice tone="warning">{preview}</Notice>
          ) : preview ? (
            <div className="grid gap-4 md:grid-cols-2">
              <table className="text-[length:var(--text-sm)]">
                <caption className="text-start font-medium">مبلغ‌ها</caption>
                <tbody>
                  {preview.lines.map((l) => (
                    <tr key={l.label}>
                      <th scope="row" className="pe-3 text-start font-normal">
                        {l.label}
                      </th>
                      <td className="figures">{formatToman(l.rial.toString())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="text-[length:var(--text-sm)]">
                <caption className="text-start font-medium">جدول اقساط نمونه</caption>
                <thead>
                  <tr>
                    <th scope="col" className="text-start">
                      قسط
                    </th>
                    <th scope="col" className="text-start">
                      سررسید
                    </th>
                    <th scope="col" className="text-start">
                      مبلغ
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.installments.map((s) => (
                    <tr key={s.index}>
                      <td>{fa(s.index)}</td>
                      <td>{s.due}</td>
                      <td className="figures" title={formatRial(s.rial.toString())}>
                        {formatToman(s.rial.toString())}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </fieldset>
    );
  };

  return (
    <div className="space-y-4">
      <Notice tone="info">
        هر پرونده روی نسخه طرح‌های زمان خودش قفل است؛ تغییر اینجا فقط روی پرونده‌های بعدی اثر دارد.
        طرح حذف نمی‌شود، غیرفعال می‌شود. «اجرا از» برای کل این نسخه طرح‌هاست.
      </Notice>
      {draft.plans.map((p, i) => (
        <details key={p.code} className="rounded-lg border border-border bg-surface p-4">
          <summary className="cursor-pointer font-bold">
            {p.title || p.code} · {p.active ? 'فعال' : 'غیرفعال'} ·{' '}
            {p.treatmentFieldCodes.map(fieldName).join('، ') || 'بی رشته'}
          </summary>
          <div className="pt-4">{form(p, i)}</div>
        </details>
      ))}
      {mayEdit && (
        <>
          <NewPlan
            onAdd={(code, title) => {
              change(addPlan(draft, code, title));
            }}
          />
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              setReview({
                value: draft,
                changes: planChanges(current, draft),
                problems: planProblems(draft),
              });
            }}
          >
            نمایش تغییرات
          </button>
        </>
      )}
      {review && (
        <ProposalForm
          configKey="credit.plans"
          value={review.value}
          changes={review.changes}
          problems={review.problems}
          withEffectiveDay
          today={today}
        />
      )}
      <RawJson value={current} />
    </div>
  );
}

/** A new plan's code (its identity, kept for ever) and name; it starts off. */
function NewPlan({ onAdd }: { onAdd: (code: string, title: string) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      aria-label="طرح تازه"
      className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const field = (name: string) => {
          const v = data.get(name);
          return typeof v === 'string' ? v.trim() : '';
        };
        const code = field('code');
        const title = field('title');
        if (!/^[a-z][a-z0-9_]{0,62}$/.test(code)) {
          setProblem('کد طرح با حرف لاتین کوچک شروع شود و فقط حرف لاتین کوچک، رقم و _ داشته باشد.');
          return;
        }
        if (title.length < 2) {
          setProblem('نام طرح را بنویسید.');
          return;
        }
        setProblem(null);
        onAdd(code, title);
        e.currentTarget.reset();
      }}
    >
      <div className="space-y-1">
        <label htmlFor="new-plan-code" className={label}>
          کد طرح تازه
        </label>
        <input id="new-plan-code" name="code" dir="ltr" className={inputClass} />
      </div>
      <div className="grow space-y-1">
        <label htmlFor="new-plan-title" className={label}>
          نام طرح تازه
        </label>
        <input id="new-plan-title" name="title" className={inputClass} />
      </div>
      <button type="submit" className={buttonClass('quiet')}>
        افزودن طرح (غیرفعال)
      </button>
      {problem && <Notice tone="danger">{problem}</Notice>}
    </form>
  );
}
