'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Finance cancels an authorization, or a recorded service not yet final, with a reason
 * (owner, task 4-6 ت۲): the reservation freed, a recorded service reversed on the purse's
 * memo chain by the service. A final one is phase 5's to dispute (`service_final`).
 */
export function CancelService({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className={buttonClass('secondary')}
        onClick={() => {
          setOpen(true);
        }}
      >
        لغو با دلیل
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
          api.POST('/api/v1/service/authorizations/{id}/cancel', {
            params: { path: { id } },
            body: { reason },
          }),
        )
          .then(() => {
            setOpen(false);
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
      <TextField id={`cancel-reason-${id}`} name="reason" label="دلیل لغو" required />
      <button type="submit" disabled={busy} className={buttonClass('danger')}>
        لغو مجوز
      </button>
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setOpen(false);
        }}
      >
        انصراف
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
