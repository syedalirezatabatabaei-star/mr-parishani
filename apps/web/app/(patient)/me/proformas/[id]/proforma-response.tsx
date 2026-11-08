'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

/** The patient confirms an issued proforma, or disputes it with a note (doc 10 §2). */
export function ProformaResponse({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [disputing, setDisputing] = useState(false);
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

  if (disputing) {
    const submit = (e: SubmitEvent<HTMLFormElement>) => {
      e.preventDefault();
      const note = formText(e.currentTarget, 'note');
      void run(() =>
        unwrap(
          api.POST('/api/v1/me/proformas/{id}/dispute', {
            params: { path: { id } },
            body: { note },
          }),
        ),
      );
    };
    return (
      <form onSubmit={submit} className="space-y-2" noValidate>
        <TextField id="dispute-note" name="note" label="شرح اعتراض" required error={error} />
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className={buttonClass('danger')}>
            ثبت اعتراض
          </button>
          <button
            type="button"
            className={buttonClass('quiet')}
            onClick={() => {
              setDisputing(false);
            }}
          >
            انصراف
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() =>
          void run(() =>
            unwrap(api.POST('/api/v1/me/proformas/{id}/confirm', { params: { path: { id } } })),
          )
        }
      >
        تأیید پیش‌فاکتور
      </button>
      <button
        type="button"
        className={buttonClass('secondary')}
        onClick={() => {
          setDisputing(true);
        }}
      >
        اعتراض دارم
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
