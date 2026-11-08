'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  TextAreaField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

function useRun() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

/** A document's short-lived link (rule 28), opened in a new tab; the view is recorded. */
export function OpenDocument({
  requestId,
  documentId,
  label,
}: {
  requestId: string;
  documentId: string;
  label: string;
}) {
  const api = useApi();
  const { error, busy, run } = useRun();
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('secondary')}
        onClick={() => {
          void run(async () => {
            const link = await unwrap(
              api.GET('/api/v1/catalog/partnership-requests/{id}/documents/{documentId}/link', {
                params: { path: { id: requestId, documentId } },
              }),
            );
            window.open(link.url, '_blank', 'noopener');
          });
        }}
      >
        {label}
      </button>
      {error && <span className="text-[length:var(--text-sm)] text-danger">{error}</span>}
    </span>
  );
}

/**
 * The specialist's review (owner 1405/08/10): the identifier read from the documents; the
 * center is registered as a draft by the same registration as by hand.
 */
export function ReviewRequest({ id, legal }: { id: string; legal: boolean }) {
  const api = useApi();
  const { error, setError, busy, run } = useRun();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const note = formText(form, 'note').trim();
    if (note.length < 3) {
      setError('یادداشت بررسی را بنویسید.');
      return;
    }
    void run(() =>
      unwrap(
        api.POST('/api/v1/catalog/partnership-requests/{id}/review', {
          params: { path: { id } },
          body: {
            identifier: formText(form, 'identifier'),
            licenseNumber: formText(form, 'license').trim() || null,
            note,
          },
        }),
      ),
    );
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="تأیید اولیه"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 className="font-bold">تأیید اولیه و ثبت پیش‌نویس مرکز</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="identifier"
          name="identifier"
          label={legal ? 'شناسه ملی شخص حقوقی' : 'کد ملی صاحب مرکز'}
          hint="از روی مدارک بارگذاری‌شده؛ رمزگذاری‌شده نگه داشته می‌شود."
          inputMode="numeric"
          dir="ltr"
          figures
          required
        />
        <TextField id="license" name="license" label="شماره پروانه (اختیاری)" dir="ltr" figures />
      </div>
      <TextAreaField id="note" name="note" label="یادداشت بررسی" rows={2} required />
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        تأیید اولیه (مرکز پیش‌نویس ساخته می‌شود)
      </button>
    </form>
  );
}

/** The manager's final approval: the account, the role on this center only, the SMS link. */
export function ApproveRequest({ id }: { id: string }) {
  const api = useApi();
  const { error, setError, busy, run } = useRun();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const note = formText(e.currentTarget, 'note').trim();
    if (note.length < 3) {
      setError('یادداشت تأیید را بنویسید.');
      return;
    }
    void run(() =>
      unwrap(
        api.POST('/api/v1/catalog/partnership-requests/{id}/approve', {
          params: { path: { id } },
          body: { note },
        }),
      ),
    );
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="تأیید نهایی"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 className="font-bold">تأیید نهایی</h2>
      <p className="text-[length:var(--text-sm)] text-ink-muted">
        حساب مدیر مرکز با موبایل تأییدشده درخواست ساخته می‌شود، فقط روی همین مرکز نقش می‌گیرد و
        پیوند یک‌بارمصرف ساخت رمز پیامک می‌شود. مرکز تا فعال‌سازی دونفره پیش‌نویس می‌ماند.
      </p>
      <TextAreaField id="approve-note" name="note" label="یادداشت تأیید" rows={2} required />
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        تأیید نهایی و ارسال پیوند
      </button>
    </form>
  );
}

/** Refused with a reason the applicant receives by SMS. */
export function RejectRequest({ id }: { id: string }) {
  const api = useApi();
  const { error, setError, busy, run } = useRun();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = formText(e.currentTarget, 'reason').trim();
    if (reason.length < 3) {
      setError('دلیل رد را بنویسید؛ برای متقاضی پیامک می‌شود.');
      return;
    }
    void run(() =>
      unwrap(
        api.POST('/api/v1/catalog/partnership-requests/{id}/reject', {
          params: { path: { id } },
          body: { reason },
        }),
      ),
    );
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="رد درخواست"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 className="font-bold">رد درخواست</h2>
      <TextField
        id="reason"
        name="reason"
        label="دلیل رد"
        hint="برای متقاضی پیامک می‌شود؛ کوتاه و روشن."
        required
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass('danger')}>
        رد درخواست
      </button>
    </form>
  );
}
