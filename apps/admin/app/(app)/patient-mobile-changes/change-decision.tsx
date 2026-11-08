'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

type Decision = 'approve' | 'reject';

/**
 * The second of the two (ف۱۲ ب۲): approving, never by the proposer (the API and the database
 * refuse it), or refusing, which takes one, the proposer too. A reason either way.
 */
export function ChangeDecision({ id, mine }: { id: string; mine: boolean }) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!open) return;
    const reason = formText(e.currentTarget, 'reason');
    setBusy(true);
    setError(null);
    try {
      const options = { params: { path: { id } }, body: { reason } };
      if (open === 'approve') {
        await unwrap(api.POST('/api/v1/identity/patient-mobile-changes/{id}/approve', options));
      } else {
        await unwrap(api.POST('/api/v1/identity/patient-mobile-changes/{id}/reject', options));
      }
      setOpen(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="flex flex-wrap gap-2">
        {mine ? null : (
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              setOpen('approve');
            }}
          >
            تأیید نفر دوم
          </button>
        )}
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setOpen('reject');
          }}
        >
          {mine ? 'پس گرفتن' : 'رد'}
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2" noValidate>
      <TextField id={`reason-${id}`} name="reason" label="دلیل" required />
      {open === 'approve' ? (
        <Notice tone="info">
          با تأیید، شماره ورود بیمار عوض می‌شود، همه نشست‌هایش بسته می‌شود و به شماره قبلی پیامک
          می‌رود.
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className={buttonClass(open === 'reject' ? 'danger' : 'primary')}
        >
          {open === 'approve' ? 'تأیید' : 'رد'}
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setOpen(null);
          }}
        >
          انصراف
        </button>
      </div>
    </form>
  );
}
