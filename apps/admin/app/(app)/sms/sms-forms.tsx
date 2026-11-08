'use client';

import { unwrap } from '@sepehr/api-client';
import { formatJalaliDate, type JalaliDate } from '@sepehr/contracts';
import {
  buttonClass,
  DateField,
  errorMessage,
  formText,
  Notice,
  SelectField,
  tehranToday,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await action();
      setDone(message);
      router.refresh();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, done, busy, run };
}

const AUDIENCES = [
  { value: 'patient', label: 'بیمار' },
  { value: 'borrower', label: 'وام‌گیرنده' },
  { value: 'guarantor', label: 'ضامن' },
  { value: 'doctor', label: 'پزشک' },
  { value: 'staff', label: 'کارکنان' },
];

/**
 * A template's new version (or its first): a field its recipient may not see is refused by
 * the API with the field named (a guarantor never sees the treatment, doctor or center).
 */
export function TemplateForm() {
  const api = useApi();
  const { error, done, busy, run } = useAction();
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="قالب تازه یا نسخه تازه"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        void run(
          () =>
            unwrap(
              api.POST('/api/v1/notification/sms-templates', {
                body: {
                  code: formText(form, 'code').trim(),
                  audience: formText(form, 'audience') as 'patient',
                  category: formText(form, 'category') as 'transactional',
                  body: formText(form, 'body'),
                  reason: formText(form, 'reason').trim(),
                },
              }),
            ),
          'قالب ذخیره شد.',
        ).then((ok) => {
          if (ok) form.reset();
        });
      }}
    >
      <h2 className="font-bold">قالب تازه یا نسخه تازه</h2>
      <p className="text-ink-muted">
        فیلدها با {'{{'}نام{'}}'} نوشته می‌شوند؛ هر گیرنده فقط فیلدهای مجاز خود را دارد.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField id="tpl-code" name="code" label="کد (مثل repayment.notice)" dir="ltr" required />
        <SelectField id="tpl-aud" name="audience" label="گیرنده" options={AUDIENCES} />
        <SelectField
          id="tpl-cat"
          name="category"
          label="دسته"
          options={[
            { value: 'transactional', label: 'خدماتی و اطلاع‌رسانی' },
            { value: 'promotional', label: 'تبلیغاتی (نیازمند رضایت)' },
            { value: 'urgent', label: 'فوری (کد ورود و خدمت)' },
          ]}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="tpl-body" className="block text-[length:var(--text-sm)] font-medium">
          متن
        </label>
        <textarea
          id="tpl-body"
          name="body"
          rows={3}
          required
          className="w-full rounded-md border border-border p-2"
        />
      </div>
      <TextField id="tpl-reason" name="reason" label="دلیل تغییر" required />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ذخیره قالب
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </form>
  );
}

/**
 * One SMS at a Jalali day and hour (Tehran), moved into the allowed hours by the system; to a
 * person (from their case) or, for a staff template, to a staff mobile.
 */
export function ScheduleSms({ personId }: { personId?: string }) {
  const api = useApi();
  const { error, setError, done, busy, run } = useAction();
  const [day, setDay] = useState<JalaliDate | null>(null);
  const today = tehranToday();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!day) {
      setError('روز ارسال را انتخاب کنید.');
      return;
    }
    const values: Record<string, string> = {};
    for (const line of formText(form, 'values').split('\n')) {
      const [k, ...rest] = line.split('=');
      if (k?.trim() && rest.length > 0) values[k.trim()] = rest.join('=').trim();
    }
    const to = personId ? { personId } : { mobile: formText(form, 'mobile').trim() };
    void run(
      () =>
        unwrap(
          api.POST('/api/v1/notification/scheduled-sms', {
            body: {
              templateCode: formText(form, 'templateCode').trim(),
              ...to,
              values,
              sendAt: { date: formatJalaliDate(day), time: formText(form, 'time') },
              reason: formText(form, 'reason').trim(),
            },
          }),
        ),
      'پیامک زمان‌بندی شد.',
    );
  };
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="پیامک زمان‌بندی‌شده"
      noValidate
      onSubmit={submit}
    >
      <h2 className="font-bold">پیامک زمان‌بندی‌شده</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField id="sch-template" name="templateCode" label="کد قالب" dir="ltr" required />
        {!personId && (
          <TextField
            id="sch-mobile"
            name="mobile"
            label="موبایل کارمند"
            dir="ltr"
            figures
            required
          />
        )}
        <DateField
          mode="single"
          label="روز ارسال"
          today={today}
          min={today}
          value={day}
          onChange={setDay}
        />
        <TextField id="sch-time" name="time" label="ساعت (مثل 10:30)" dir="ltr" figures required />
        <TextField id="sch-reason" name="reason" label="دلیل" required />
      </div>
      <div className="space-y-1">
        <label htmlFor="sch-values" className="block text-[length:var(--text-sm)] font-medium">
          مقدار فیلدها، هر خط «نام=مقدار»
        </label>
        <textarea
          id="sch-values"
          name="values"
          rows={3}
          className="w-full rounded-md border border-border p-2"
        />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        زمان‌بندی
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </form>
  );
}

export function CancelScheduled({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <span className="space-y-1">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('secondary')}
        onClick={() =>
          void run(
            () =>
              unwrap(
                api.POST('/api/v1/notification/scheduled-sms/{id}/cancel', {
                  params: { path: { id } },
                  body: { reason: 'لغو از پنل پیامک' },
                }),
              ),
            'لغو شد.',
          )
        }
      >
        لغو
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </span>
  );
}

/** Consent to promotional SMS given or withdrawn, with a reason (doc 15 §7). */
export function ConsentForm() {
  const api = useApi();
  const { error, done, busy, run } = useAction();
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
      aria-label="رضایت پیامک تبلیغاتی"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        void run(
          () =>
            unwrap(
              api.POST('/api/v1/notification/sms-consents', {
                body: {
                  mobile: formText(form, 'mobile').trim(),
                  action: formText(form, 'action') === 'withdraw' ? 'withdraw' : 'consent',
                  reason: formText(form, 'reason').trim(),
                },
              }),
            ),
          'ثبت شد.',
        ).then((ok) => {
          if (ok) form.reset();
        });
      }}
    >
      <TextField id="consent-mobile" name="mobile" label="موبایل" dir="ltr" figures required />
      <SelectField
        id="consent-action"
        name="action"
        label="رضایت تبلیغاتی"
        options={[
          { value: 'consent', label: 'داده شد' },
          { value: 'withdraw', label: 'لغو شد' },
        ]}
      />
      <TextField id="consent-reason" name="reason" label="دلیل" required />
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        ثبت رضایت
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </form>
  );
}
