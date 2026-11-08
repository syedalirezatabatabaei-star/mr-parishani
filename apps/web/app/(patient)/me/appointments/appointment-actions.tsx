'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

type Action = 'cancel' | 'dispute';

const COPY: Readonly<Record<Action, { open: string; label: string; submit: string }>> = {
  cancel: { open: 'لغو نوبت', label: 'دلیل لغو', submit: 'لغو نوبت' },
  dispute: { open: 'اعتراض به عدم حضور', label: 'شرح اعتراض', submit: 'ثبت اعتراض' },
};

/**
 * What a patient can do with one appointment: cancel it (the API checks the time limit,
 * doc 09 open item 9) or dispute a no-show. Both ask for a reason (rule 9: the audit
 * trail), then the list is read again from the server.
 */
export function AppointmentActions({
  id,
  canCancel,
  canDispute,
}: {
  id: string;
  canCancel: boolean;
  canDispute: boolean;
}) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canCancel && !canDispute) return null;

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!open) return;
    const reason = formText(e.currentTarget, 'reason');
    setBusy(true);
    setError(null);
    try {
      const path = { params: { path: { id } }, body: { reason } };
      if (open === 'cancel') {
        await unwrap(api.POST('/api/v1/booking/me/appointments/{id}/cancel', path));
      } else {
        await unwrap(api.POST('/api/v1/booking/me/appointments/{id}/dispute-no-show', path));
      }
      setOpen(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <form onSubmit={(e) => void submit(e)} className="space-y-2" noValidate>
        <TextField
          id={`reason-${id}`}
          name="reason"
          label={COPY[open].label}
          required
          error={error}
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className={buttonClass(open === 'cancel' ? 'danger' : 'primary')}
          >
            {COPY[open].submit}
          </button>
          <button
            type="button"
            className={buttonClass('quiet')}
            onClick={() => {
              setOpen(null);
              setError(null);
            }}
          >
            انصراف
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex gap-2">
      {canCancel && (
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setOpen('cancel');
          }}
        >
          {COPY.cancel.open}
        </button>
      )}
      {canDispute && (
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setOpen('dispute');
          }}
        >
          {COPY.dispute.open}
        </button>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
