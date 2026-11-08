'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Gives a secretary the secretary role over their doctor's workplace, for a doctor without
 * an account (a doctor with one does it themselves, doc 04 §2). Recorded with its reason.
 */
export function SecretaryRole({ secretaryId }: { secretaryId: string }) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (done) return <Notice tone="success">نقش منشی داده شد.</Notice>;
  if (!open) {
    return (
      <button
        type="button"
        className={buttonClass('secondary', 'min-h-9 px-3')}
        onClick={() => {
          setOpen(true);
        }}
      >
        دادن نقش منشی
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const reason = formText(e.currentTarget, 'reason');
        setBusy(true);
        setError(null);
        void unwrap(
          api.POST('/api/v1/catalog/secretaries/{id}/assignments', {
            params: { path: { id: secretaryId } },
            body: { roleCode: 'secretary', reason },
          }),
        )
          .then(() => {
            setDone(true);
            router.refresh();
          })
          .catch((err: unknown) => {
            setError(errorMessage(err));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <TextField
        id={`secretary-reason-${secretaryId}`}
        name="reason"
        label="دلیل"
        required
        error={error}
      />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت
      </button>
    </form>
  );
}
