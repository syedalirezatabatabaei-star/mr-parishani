'use client';

import { unwrap } from '@sepehr/api-client';
import { JALALI_MONTH_NAMES, type JalaliDate } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  faDigits,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { saveCsv } from '../settlement-actions';

/** Maps one internal account code to an Odoo account (append-only; the newest counts). */
export function OdooMappingForm() {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setError(null);
    setDone(false);
    void unwrap(
      api.POST('/api/v1/settlement/odoo/mappings', {
        body: {
          internalCode: formText(form, 'internal'),
          odooAccountCode: formText(form, 'odoo'),
          reason: formText(form, 'reason'),
        },
      }),
    )
      .then(() => {
        setDone(true);
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label="ثبت نگاشت حساب" noValidate>
      <TextField
        id="odoo-internal"
        name="internal"
        label="حساب داخلی (مثل doctor.payable)"
        dir="ltr"
        required
      />
      <TextField id="odoo-account" name="odoo" label="کد حساب در Odoo" dir="ltr" required />
      <TextField id="odoo-reason" name="reason" label="دلیل" required />
      <button type="submit" className={buttonClass('primary')}>
        ثبت نگاشت
      </button>
      {done ? <Notice tone="success">نگاشت ثبت شد.</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </form>
  );
}

/** One closed Jalali month's documents as an Odoo import file (CSV, saved by the browser). */
export function OdooExportForm({ today }: { today: JalaliDate }) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const last =
    today.month === 1
      ? { year: today.year - 1, month: 12 }
      : { year: today.year, month: today.month - 1 };
  const years = [last.year, last.year - 1, last.year - 2];
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const year = Number(formText(form, 'year'));
    const month = Number(formText(form, 'month'));
    setBusy(true);
    setError(null);
    void unwrap(api.POST('/api/v1/settlement/odoo/exports', { body: { year, month } }))
      .then((made) => {
        saveCsv(`odoo-${String(year)}-${String(month).padStart(2, '0')}.csv`, made.csv ?? '');
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label="ساخت خروجی Odoo" noValidate>
      <SelectField
        id="odoo-year"
        name="year"
        label="سال"
        defaultValue={String(last.year)}
        options={years.map((y) => ({ value: String(y), label: faDigits(y) }))}
      />
      <SelectField
        id="odoo-month"
        name="month"
        label="ماه"
        defaultValue={String(last.month)}
        options={JALALI_MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name }))}
      />
      <button type="submit" className={buttonClass('primary')} disabled={busy}>
        ساخت و دریافت فایل
      </button>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </form>
  );
}
