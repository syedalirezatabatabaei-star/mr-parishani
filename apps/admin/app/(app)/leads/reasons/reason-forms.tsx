'use client';

import { unwrap } from '@sepehr/api-client';
import { normalizeDigits } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
  type SelectOption,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode, type SubmitEvent } from 'react';

const SECTION = 'space-y-3 rounded-lg border border-border bg-surface p-4';

/** An order typed in any digits; empty means unchanged (or 0 for a new reason). */
const orderOf = (form: HTMLFormElement): number | undefined => {
  const typed = normalizeDigits(formText(form, 'sortOrder')).trim();
  return typed === '' ? undefined : Number(typed);
};

/** One form of this page: sends, then reads the page again; the API's refusal as it is. */
function ReasonForm({
  id,
  title,
  submit,
  tone = 'primary',
  send,
  children,
}: {
  id: string;
  title: string;
  submit: string;
  tone?: 'primary' | 'danger';
  send: (form: HTMLFormElement) => Promise<unknown>;
  children: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setDone(false);
    void send(form)
      .then(() => {
        setDone(true);
        form.reset();
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
    <section aria-labelledby={id} className={SECTION}>
      <h2 id={id} className="font-bold">
        {title}
      </h2>
      <form className="space-y-3" noValidate onSubmit={onSubmit}>
        <div className="flex flex-wrap items-end gap-3">{children}</div>
        <button type="submit" disabled={busy} className={buttonClass(tone)}>
          {submit}
        </button>
      </form>
      {done && <Notice tone="success">ثبت شد.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

export function AddReason() {
  const api = useApi();
  return (
    <ReasonForm
      id="add-reason"
      title="علت تازه"
      submit="افزودن علت"
      send={(form) => {
        const sortOrder = orderOf(form);
        return unwrap(
          api.POST('/api/v1/lead/abandonment-reasons', {
            body: {
              code: formText(form, 'code').trim(),
              title: formText(form, 'title').trim(),
              ...(sortOrder === undefined ? {} : { sortOrder }),
              reason: formText(form, 'reason'),
            },
          }),
        );
      }}
    >
      <TextField id="add-code" name="code" label="کد (لاتین)" dir="ltr" required />
      <TextField id="add-title" name="title" label="عنوان" required className="min-w-64 grow" />
      <TextField id="add-order" name="sortOrder" label="ترتیب" inputMode="numeric" dir="ltr" />
      <TextField id="add-why" name="reason" label="دلیل" required />
    </ReasonForm>
  );
}

export function EditReason({ options }: { options: readonly SelectOption[] }) {
  const api = useApi();
  return (
    <ReasonForm
      id="edit-reason"
      title="ویرایش علت"
      submit="ثبت ویرایش"
      send={(form) => {
        const title = formText(form, 'title').trim();
        const sortOrder = orderOf(form);
        return unwrap(
          api.PATCH('/api/v1/lead/abandonment-reasons/{code}', {
            params: { path: { code: formText(form, 'code') } },
            body: {
              ...(title ? { title } : {}),
              ...(sortOrder === undefined ? {} : { sortOrder }),
              reason: formText(form, 'reason'),
            },
          }),
        );
      }}
    >
      <SelectField
        id="edit-code"
        name="code"
        label="علت"
        options={options}
        emptyLabel="انتخاب کنید"
      />
      <TextField
        id="edit-title"
        name="title"
        label="عنوان تازه"
        hint="خالی: بی تغییر"
        className="min-w-64 grow"
      />
      <TextField
        id="edit-order"
        name="sortOrder"
        label="ترتیب تازه"
        hint="خالی: بی تغییر"
        inputMode="numeric"
        dir="ltr"
      />
      <TextField id="edit-why" name="reason" label="دلیل" required />
    </ReasonForm>
  );
}

/** Retiring is a soft delete; «chose_cash» is not offered (and the API refuses it). */
export function RetireReason({ options }: { options: readonly SelectOption[] }) {
  const api = useApi();
  return (
    <ReasonForm
      id="retire-reason"
      title="کنار گذاشتن علت"
      submit="کنار گذاشتن"
      tone="danger"
      send={(form) =>
        unwrap(
          api.POST('/api/v1/lead/abandonment-reasons/{code}/retire', {
            params: { path: { code: formText(form, 'code') } },
            body: { reason: formText(form, 'reason') },
          }),
        )
      }
    >
      <SelectField
        id="retire-code"
        name="code"
        label="علت"
        options={options}
        emptyLabel="انتخاب کنید"
      />
      <TextField id="retire-why" name="reason" label="دلیل" required className="min-w-64 grow" />
    </ReasonForm>
  );
}
