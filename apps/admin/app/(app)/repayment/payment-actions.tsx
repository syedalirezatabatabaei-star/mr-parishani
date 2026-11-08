'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Finance approves a slip (allocated by the service to the oldest installments) or rejects it
 * with its kind and a reason the borrower reads. A slip like one already received is approved
 * only when finance says it is not a duplicate, and why (task 6-2, owner Q2).
 */
export function DecidePayment({ id, flagged }: { id: string; flagged: boolean }) {
  const api = useApi();
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'approve' | 'reject'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode('idle');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const approve = (reason?: string) =>
    run(() =>
      unwrap(
        api.POST('/api/v1/repayment/payments/{id}/approve', {
          params: { path: { id } },
          body: reason ? { notDuplicate: true, reason } : {},
        }),
      ),
    );

  if (mode === 'reject' || (mode === 'approve' && flagged)) {
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason').trim();
          if (mode === 'approve') return void approve(reason);
          const kind = formText(e.currentTarget, 'kind') as 'not_received' | 'received_unaccepted';
          void run(() =>
            unwrap(
              api.POST('/api/v1/repayment/payments/{id}/reject', {
                params: { path: { id } },
                body: { kind, reason },
              }),
            ),
          );
        }}
      >
        {mode === 'reject' && (
          <SelectField
            id={`kind-${id}`}
            name="kind"
            label="نوع رد"
            options={[
              { value: 'not_received', label: 'به حساب نرسیده' },
              { value: 'received_unaccepted', label: 'رسیده، ولی پذیرفته نمی‌شود' },
            ]}
          />
        )}
        <TextField
          id={`reason-${id}`}
          name="reason"
          label={mode === 'approve' ? 'چرا تکراری نیست؟' : 'دلیل رد (برای وام‌گیرنده)'}
          required
        />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          {mode === 'approve' ? 'تأیید با این توضیح' : 'رد فیش'}
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setMode('idle');
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
        onClick={() => {
          if (flagged) setMode('approve');
          else void approve();
        }}
      >
        تأیید
      </button>
      <button
        type="button"
        className={buttonClass('secondary')}
        onClick={() => {
          setMode('reject');
        }}
      >
        رد
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </span>
  );
}
