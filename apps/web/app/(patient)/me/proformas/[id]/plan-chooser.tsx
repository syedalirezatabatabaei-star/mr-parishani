'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  faDigits,
  Notice,
  showDay,
  TextField,
  toman,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

interface Quote {
  readonly downPaymentRial: string;
  readonly loanRial: string;
  readonly cashTopUpRial: string;
  /** ADR-050: the materials of a wage-only plan, in the cash to the doctor. */
  readonly materialCashRial: string;
  readonly planFeeRial: string;
  readonly planFeeTiming: 'at_completion' | 'spread';
  readonly originationFeeRial: string;
  readonly dueAtCompletionRial: string;
  readonly totalObligationRial: string;
  readonly totalPayableRial: string;
  readonly installments: readonly { index: number; dueOn: string; amountRial: string }[];
}

export interface PlanOption {
  readonly code: string;
  readonly title: string;
  readonly options: readonly { installmentCount: number; quote: Quote }[];
}

/**
 * The plans that can finance a confirmed proforma, side by side (doc 10 §3): for each
 * installment count, what is paid now, at completion and in each installment, with the
 * due days in the Jalali calendar, every figure labelled approximate (owner 1405/07/22, M1
 * §8.7 option ب): the application locks the configuration of the moment it is made (rule 16),
 * and its page shows those locked figures before it is submitted. The borrower may be someone else, by mobile (doc 01: Borrower ≠ Patient).
 */
export function PlanChooser({
  proformaId,
  plans,
}: {
  proformaId: string;
  plans: readonly PlanOption[];
}) {
  const api = useApi();
  const router = useRouter();
  const first = plans[0];
  const [chosen, setChosen] = useState(
    first ? `${first.code}:${String(first.options[0]?.installmentCount ?? 0)}` : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, count] = chosen.split(':');
  const plan = plans.find((p) => p.code === code);
  const option = plan?.options.find((o) => String(o.installmentCount) === count);

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!plan || !option) return;
    const mobile = new FormData(e.currentTarget).get('borrowerMobile');
    setBusy(true);
    setError(null);
    try {
      const made = await unwrap(
        api.POST('/api/v1/me/credit-applications', {
          body: {
            proformaId,
            planCode: plan.code,
            installmentCount: option.installmentCount,
            ...(typeof mobile === 'string' && mobile.trim()
              ? { borrowerMobile: mobile.trim() }
              : {}),
          },
        }),
      );
      router.push(`/me/credit/${made.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      <fieldset className="space-y-3">
        <legend className="text-[length:var(--text-lg)] font-bold">انتخاب طرح اعتباری</legend>
        {plans.map((p) => (
          <div key={p.code} className="space-y-2 rounded-lg border border-border bg-surface p-4">
            <p className="font-bold">{p.title}</p>
            <ul className="flex flex-wrap gap-2">
              {p.options.map((o) => {
                const value = `${p.code}:${String(o.installmentCount)}`;
                const id = `plan-${p.code}-${String(o.installmentCount)}`;
                return (
                  <li key={value}>
                    <input
                      type="radio"
                      id={id}
                      name="plan"
                      value={value}
                      checked={chosen === value}
                      onChange={() => {
                        setChosen(value);
                      }}
                      className="peer sr-only"
                    />
                    <label
                      htmlFor={id}
                      className="block cursor-pointer rounded-md border border-border-strong px-3 py-2 peer-checked:border-2 peer-checked:border-accent peer-focus-visible:outline-2"
                    >
                      <span className="figures">{faDigits(o.installmentCount)} قسط</span>
                      {' · '}
                      <span className="figures">
                        هر قسط تقریبی {toman(o.quote.installments[0]?.amountRial ?? '0')}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </fieldset>

      {option && (
        <section className="space-y-3" aria-labelledby="preview-title">
          <h2 id="preview-title" className="text-[length:var(--text-lg)] font-bold">
            پیش‌نمایش تقریبی {plan?.title}، {faDigits(option.installmentCount)} قسط
          </h2>
          <Notice tone="info">
            این مبالغ تقریبی‌اند. مبالغ قطعی، با پیکربندی لحظه ثبت درخواست، پس از ثبت و پیش از ارسال
            در صفحه درخواست نشان داده می‌شوند.
          </Notice>
          <dl className="grid gap-2 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
            <Row label="پیش‌پرداخت" value={option.quote.downPaymentRial} />
            <Row label="مبلغ وام" value={option.quote.loanRial} />
            {option.quote.cashTopUpRial !== '0' && (
              <Row label="پرداخت نقدی نزد پزشک" value={option.quote.cashTopUpRial} />
            )}
            {option.quote.materialCashRial !== '0' && (
              <Row
                label="از آن، هزینه مواد (وام فقط دستمزد)"
                value={option.quote.materialCashRial}
              />
            )}
            <Row label="هزینه تشکیل پرونده" value={option.quote.originationFeeRial} />
            <Row
              label={
                option.quote.planFeeTiming === 'spread'
                  ? 'کارمزد طرح (در اقساط)'
                  : 'کارمزد طرح (هنگام تکمیل)'
              }
              value={option.quote.planFeeRial}
            />
            <Row label="جمع اقساط" value={option.quote.totalObligationRial} />
            <Row label="جمع همه پرداخت‌ها" value={option.quote.totalPayableRial} />
          </dl>
          <table className="w-full text-[length:var(--text-sm)]">
            <caption className="text-start font-bold">جدول اقساط (تقریبی)</caption>
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
              {option.quote.installments.map((i) => (
                <tr key={i.index} className="border-t border-border">
                  <td className="figures">{faDigits(i.index)}</td>
                  <td className="figures">{showDay(i.dueOn)}</td>
                  <td className="figures">{toman(i.amountRial)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[length:var(--text-xs)] text-ink-subtle">
            سررسیدها از روز فرضی واریز امروز حساب شده‌اند و پس از واریز واقعی دوباره تنظیم می‌شوند.
          </p>
        </section>
      )}

      <TextField
        id="borrowerMobile"
        name="borrowerMobile"
        type="tel"
        inputMode="tel"
        dir="ltr"
        figures
        label="موبایل وام‌گیرنده (اختیاری)"
        hint="اگر وام به نام شخص دیگری است، موبایل او را بنویسید؛ خالی یعنی خودتان."
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" disabled={busy || !option} className={buttonClass('primary')}>
        درخواست اعتبار با این طرح
      </button>
    </form>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="figures font-bold">{toman(value)}</dd>
    </div>
  );
}
