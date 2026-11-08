'use client';

import { unwrap } from '@sepehr/api-client';
import { parseRial, type JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  errorMessage,
  formText,
  MoneyField,
  Notice,
  SelectField,
  tehranToday,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

/** A reason asked inline, then the action: the common shape of the unit's decisions. */
function WithReason({
  id,
  open,
  label,
  field = 'reason',
  fieldLabel = 'دلیل',
  submit,
  extra,
}: {
  id: string;
  open: string;
  label: string;
  field?: string;
  fieldLabel?: string;
  submit: (form: HTMLFormElement) => Promise<unknown>;
  extra?: ReactNode;
}) {
  const { error, busy, run } = useAction();
  const [shown, setShown] = useState(false);
  if (!shown) {
    return (
      <button
        type="button"
        className={buttonClass('secondary')}
        onClick={() => {
          setShown(true);
        }}
      >
        {open}
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        void run(() => submit(form)).then((ok) => {
          if (ok) setShown(false);
        });
      }}
    >
      {extra}
      <TextField id={`${field}-${id}`} name={field} label={fieldLabel} required />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        {label}
      </button>
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setShown(false);
        }}
      >
        انصراف
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/** A task worked: done or dismissed, with a note (stages 1 and the broken promise). */
export function WorkTask({ id }: { id: string }) {
  const api = useApi();
  return (
    <WithReason
      id={id}
      open="ثبت انجام"
      label="ثبت"
      field="note"
      fieldLabel="نتیجه"
      extra={
        <SelectField
          id={`outcome-${id}`}
          name="outcome"
          label="نتیجه کار"
          options={[
            { value: 'done', label: 'انجام شد' },
            { value: 'dismissed', label: 'کنار گذاشته شد' },
          ]}
        />
      }
      submit={(form) =>
        unwrap(
          api.POST('/api/v1/collection/tasks/{id}/work', {
            params: { path: { id } },
            body: {
              outcome: formText(form, 'outcome') === 'dismissed' ? 'dismissed' : 'done',
              note: formText(form, 'note').trim(),
            },
          }),
        )
      }
    />
  );
}

/** Stage 2: the guarantor's SMS, sent only by this decision (owner), their fields only. */
export function SendGuarantorSms({ id }: { id: string }) {
  const api = useApi();
  return (
    <WithReason
      id={id}
      open="ارسال پیامک ضامن"
      label="ارسال"
      submit={(form) =>
        unwrap(
          api.POST('/api/v1/collection/tasks/{id}/send-guarantor-sms', {
            params: { path: { id } },
            body: { reason: formText(form, 'reason').trim() },
          }),
        )
      }
    />
  );
}

/** Stage 3 or 4 proposed to the collection manager. */
export function ProposeTask({ id }: { id: string }) {
  const api = useApi();
  return (
    <WithReason
      id={id}
      open="پیشنهاد به مدیر وصول"
      label="ثبت پیشنهاد"
      submit={(form) =>
        unwrap(
          api.POST('/api/v1/collection/tasks/{id}/propose', {
            params: { path: { id } },
            body: { reason: formText(form, 'reason').trim() },
          }),
        )
      }
    />
  );
}

/** The collection manager decides a proposal; never their own (the API refuses it). */
export function DecideTask({ id }: { id: string }) {
  const api = useApi();
  return (
    <WithReason
      id={id}
      open="تصمیم"
      label="ثبت تصمیم"
      field="note"
      fieldLabel="توضیح تصمیم"
      extra={
        <SelectField
          id={`decision-${id}`}
          name="decision"
          label="تصمیم"
          options={[
            { value: 'done', label: 'تأیید و اجرا' },
            { value: 'dismissed', label: 'رد پیشنهاد' },
          ]}
        />
      }
      submit={(form) =>
        unwrap(
          api.POST('/api/v1/collection/tasks/{id}/decide', {
            params: { path: { id } },
            body: {
              decision: formText(form, 'decision') === 'dismissed' ? 'dismissed' : 'done',
              note: formText(form, 'note').trim(),
            },
          }),
        )
      }
    />
  );
}

/** A held cheque proposed for execution (task 6-8): the manager and finance approve next. */
export function ProposeExecution({ instrumentId }: { instrumentId: string }) {
  const api = useApi();
  return (
    <WithReason
      id={instrumentId}
      open="پیشنهاد اجرای چک"
      label="ثبت پیشنهاد"
      submit={(form) =>
        unwrap(
          api.POST('/api/v1/instrument-executions', {
            body: { instrumentId, reason: formText(form, 'reason').trim() },
          }),
        )
      }
    />
  );
}

export function CancelPromise({ id }: { id: string }) {
  const api = useApi();
  return (
    <WithReason
      id={id}
      open="لغو وعده"
      label="لغو"
      submit={(form) =>
        unwrap(
          api.POST('/api/v1/collection/promises/{id}/cancel', {
            params: { path: { id } },
            body: { reason: formText(form, 'reason').trim() },
          }),
        )
      }
    />
  );
}

/** A payment promise: an amount and a Jalali day, never in the past. */
export function NewPromise({ itemId }: { itemId: string }) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  const [day, setDay] = useState<JalaliDate | null>(null);
  const today = tehranToday();
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="ثبت وعده پرداخت"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const amount = parseRial(formText(form, 'amount'));
        if (amount === null || amount <= 0n) {
          setError('مبلغ وعده را وارد کنید.');
          return;
        }
        if (!day) {
          setError('روز وعده را انتخاب کنید.');
          return;
        }
        const note = formText(form, 'note').trim();
        void run(() =>
          unwrap(
            api.POST('/api/v1/collection/items/{id}/promises', {
              params: { path: { id: itemId } },
              body: {
                amountRial: amount.toString(),
                promisedOn: apiDay(day),
                ...(note ? { note } : {}),
              },
            }),
          ),
        ).then((ok) => {
          if (ok) {
            form.reset();
            setDay(null);
          }
        });
      }}
    >
      <h3 className="font-bold">ثبت وعده پرداخت</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <MoneyField id={`promise-${itemId}`} name="amount" label="مبلغ وعده" required />
        <DateField
          mode="single"
          label="روز وعده"
          today={today}
          min={today}
          value={day}
          onChange={setDay}
        />
        <TextField id={`promise-note-${itemId}`} name="note" label="توضیح" />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت وعده
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

const KINDS = [
  { value: 'call', label: 'تماس' },
  { value: 'sms', label: 'پیامک' },
  { value: 'visit', label: 'مراجعه' },
  { value: 'letter', label: 'نامه' },
  { value: 'guarantor_contact', label: 'تماس با ضامن' },
];

/** A call, visit or letter recorded by hand, now. */
export function RecordAction({ itemId }: { itemId: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="ثبت اقدام"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const note = formText(form, 'note').trim();
        void run(() =>
          unwrap(
            api.POST('/api/v1/collection/items/{id}/actions', {
              params: { path: { id: itemId } },
              body: {
                kind: formText(form, 'kind') as 'call',
                outcome: formText(form, 'outcome').trim(),
                occurredAt: new Date().toISOString(),
                ...(note ? { note } : {}),
              },
            }),
          ),
        ).then((ok) => {
          if (ok) form.reset();
        });
      }}
    >
      <h3 className="font-bold">ثبت اقدام</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField id={`kind-${itemId}`} name="kind" label="نوع اقدام" options={KINDS} />
        <TextField id={`outcome-${itemId}`} name="outcome" label="نتیجه" required />
        <TextField id={`note-${itemId}`} name="note" label="توضیح" />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت اقدام
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
