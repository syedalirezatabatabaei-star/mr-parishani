'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
  return { error, busy, run };
}

/** A receipt's file through a short signed link; every view is logged (doc 04 §7). */
export function ViewReceipt({ id }: { id: string }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await unwrap(
        api.GET('/api/v1/receipts/{id}/link', { params: { path: { id } } }),
      );
      window.open(link.url, '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="space-y-1">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('quiet')}
        onClick={() => void open()}
      >
        مشاهده فیش
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </span>
  );
}

/**
 * Finance approves a receipt (the posting of doc 02 §4, by the service of task 4-3), or
 * rejects it with a reason the payer reads. Only the exact amount is approved; another
 * amount is refused by the API and is rejected here with its reason.
 */
export function DecideReceipt({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [rejecting, setRejecting] = useState(false);
  if (rejecting) {
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          void run(() =>
            unwrap(
              api.POST('/api/v1/receipts/{id}/reject', {
                params: { path: { id } },
                body: { reason },
              }),
            ),
          );
        }}
      >
        <TextField id={`reason-${id}`} name="reason" label="دلیل رد" required />
        <button type="submit" disabled={busy} className={buttonClass('danger')}>
          رد فیش
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setRejecting(false);
          }}
        >
          انصراف
        </button>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    );
  }
  return (
    <span className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() =>
          void run(() =>
            unwrap(api.POST('/api/v1/receipts/{id}/approve', { params: { path: { id } } })),
          )
        }
      >
        تأیید فیش
      </button>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('secondary')}
        onClick={() => {
          setRejecting(true);
        }}
      >
        رد با دلیل
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </span>
  );
}
