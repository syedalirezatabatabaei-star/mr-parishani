'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextAreaField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

/** The doctor's answer to a patient's complaint (task 7-2): shown to the patient. */
export function RespondForm({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = formText(form, 'body');
    setBusy(true);
    setError(null);
    void unwrap(
      api.POST('/api/v1/panel/complaints/{id}/respond', {
        params: { path: { id } },
        body: { body, containsTreatment: false },
      }),
    )
      .then(() => {
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
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-label="پاسخ به شکایت"
      noValidate
    >
      <TextAreaField
        id="respond-body"
        name="body"
        label="پاسخ شما"
        hint="این پاسخ برای بیمار فرستاده می‌شود."
        required
        maxLength={4000}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ارسال پاسخ
      </button>
    </form>
  );
}
