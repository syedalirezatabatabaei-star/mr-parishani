'use client';

import { unwrap } from '@sepehr/api-client';
import { normalizeDigits, parseRial, type JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  errorMessage,
  formText,
  MoneyField,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export type SettlementKey =
  | 'settlement.credit_service_fee'
  | 'settlement.cash_service_fee'
  | 'settlement.contract_cycle_months'
  | 'settlement.provider_contract'
  | 'settlement.provider_contract_warn_days';

const LEVELS: Readonly<Record<SettlementKey, readonly { value: string; label: string }[]>> = {
  'settlement.credit_service_fee': [
    { value: 'global', label: 'سراسری' },
    { value: 'treatment_field', label: 'فیلد درمان' },
    { value: 'center', label: 'مرکز' },
    { value: 'doctor', label: 'پزشک' },
  ],
  'settlement.cash_service_fee': [
    { value: 'global', label: 'سراسری' },
    { value: 'treatment_field', label: 'فیلد درمان' },
    { value: 'center', label: 'مرکز' },
    { value: 'doctor', label: 'پزشک' },
  ],
  'settlement.contract_cycle_months': [
    { value: 'global', label: 'سراسری' },
    { value: 'treatment_field', label: 'فیلد درمان' },
    { value: 'doctor', label: 'پزشک' },
  ],
  // ADR-046: the contract term of a center or a doctor; globally, none.
  'settlement.provider_contract': [
    { value: 'center', label: 'مرکز' },
    { value: 'doctor', label: 'پزشک' },
    { value: 'global', label: 'سراسری' },
  ],
  'settlement.provider_contract_warn_days': [{ value: 'global', label: 'سراسری' }],
};

/**
 * A new value for one settlement rate (task 5-1; CLAUDE.md §4): at a level, a percent or a
 * fixed amount (the cycle: whole months). Held until another person approves it; it counts
 * only for services final after that, each locking the value in force then.
 */
export function ProposeSettlementRate({
  configKey,
  today,
}: {
  configKey: SettlementKey;
  today: JalaliDate;
}) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [basis, setBasis] = useState<'percent' | 'fixed'>('percent');
  const term = configKey === 'settlement.provider_contract';
  const warn = configKey === 'settlement.provider_contract_warn_days';
  const [level, setLevel] = useState(term ? 'center' : 'global');
  const [startsOn, setStartsOn] = useState<JalaliDate | null>(null);
  const cycle = configKey === 'settlement.contract_cycle_months';

  const submit = async (form: HTMLFormElement) => {
    setError(null);
    setDone(null);
    let value: unknown;
    if (term) {
      // ADR-046: from a day, for 3, 6 or 12 months; «none» records no term at this level.
      const months = formText(form, 'term-months');
      if (months === 'none') value = { startsOn: null, months: null };
      else if (!startsOn) {
        setError('روز شروع قرارداد را انتخاب کنید.');
        return;
      } else value = { startsOn: apiDay(startsOn), months: Number(months) };
    } else if (warn) {
      const days = Number(normalizeDigits(formText(form, 'days')).trim());
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        setError('روزها را عدد صحیح بین ۰ تا ۳۶۵ وارد کنید.');
        return;
      }
      value = days;
    } else if (cycle) {
      const months = Number(normalizeDigits(formText(form, 'months')).trim());
      if (!Number.isInteger(months) || months < 1 || months > 36) {
        setError('دوره را به ماه، عدد صحیح بین ۱ تا ۳۶، وارد کنید.');
        return;
      }
      value = months;
    } else if (basis === 'percent') {
      const typed = normalizeDigits(formText(form, 'percent')).trim();
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(typed) || Number(typed) > 100) {
        setError('درصد را بین ۰ تا ۱۰۰ و با حداکثر دو رقم اعشار وارد کنید.');
        return;
      }
      value = { basis: 'percent', bps: Math.round(Number(typed) * 100) };
    } else {
      const amount = parseRial(formText(form, 'amount'));
      if (amount === null || amount < 0n) {
        setError('مبلغ را به ریال و بدون اعشار وارد کنید.');
        return;
      }
      value = { basis: 'fixed', rial: amount.toString() };
    }
    const ref = formText(form, 'ref').trim();
    if (level !== 'global' && !ref) {
      setError('برای این سطح، مرجع آن را وارد کنید.');
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.POST('/api/v1/config/proposals', {
          body: {
            key: configKey,
            scope: level === 'global' ? { level: 'global' } : { level, ref },
            value,
            reason: formText(form, 'reason'),
          } as never,
        }),
      );
      setDone('پیشنهاد ثبت شد و منتظر تأیید نفر دوم است.');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="پیشنهاد نرخ تازه"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="rate-level"
          name="level"
          label="سطح"
          defaultValue={level}
          onChange={(v) => {
            setLevel(v);
          }}
          options={LEVELS[configKey]}
        />
        {level !== 'global' && (
          <TextField
            id="rate-ref"
            name="ref"
            label={
              level === 'treatment_field'
                ? 'کد فیلد درمان'
                : level === 'center'
                  ? 'شناسه گره مرکز'
                  : 'شناسه گره پزشک'
            }
            dir="ltr"
            required
          />
        )}
        {term ? (
          <>
            <DateField
              mode="single"
              label="روز شروع قرارداد"
              today={today}
              value={startsOn}
              onChange={setStartsOn}
            />
            <SelectField
              id="rate-term-months"
              name="term-months"
              label="مدت قرارداد"
              defaultValue="12"
              options={[
                { value: '3', label: '۳ ماه' },
                { value: '6', label: '۶ ماه' },
                { value: '12', label: '۱۲ ماه' },
                { value: 'none', label: 'بی مدت (مسدود نمی‌شود)' },
              ]}
            />
          </>
        ) : warn ? (
          <TextField
            id="rate-days"
            name="days"
            label="هشدار پیش از پایان (روز)"
            dir="ltr"
            figures
            required
          />
        ) : cycle ? (
          <TextField
            id="rate-months"
            name="months"
            label="دوره تسویه (ماه)"
            dir="ltr"
            figures
            required
          />
        ) : (
          <>
            <SelectField
              id="rate-basis"
              name="basis"
              label="نوع نرخ"
              defaultValue={basis}
              onChange={(v) => {
                setBasis(v === 'fixed' ? 'fixed' : 'percent');
              }}
              options={[
                { value: 'percent', label: 'درصد از مبلغ خدمت' },
                { value: 'fixed', label: 'مبلغ ثابت برای هر خدمت' },
              ]}
            />
            {basis === 'percent' ? (
              <TextField
                id="rate-percent"
                name="percent"
                label="درصد"
                hint="گرد به پایین تا ریال."
                dir="ltr"
                figures
                required
              />
            ) : (
              <MoneyField id="rate-amount" name="amount" label="مبلغ (ریال)" required />
            )}
          </>
        )}
        <TextField id="rate-reason" name="reason" label="دلیل تغییر" required />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت پیشنهاد
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </form>
  );
}
