'use client';

import { unwrap } from '@sepehr/api-client';
import {
  apiDay,
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
import type { JalaliDate } from '@sepehr/contracts';
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
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

/** The collection manager's or finance's approval; never the proposer's, never twice by one. */
export function ApproveExecution({
  id,
  collection,
  finance,
}: {
  id: string;
  collection: boolean;
  finance: boolean;
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const approve = (as: 'collection' | 'finance') =>
    run(() =>
      unwrap(
        api.POST('/api/v1/instrument-executions/{id}/approve', {
          params: { path: { id } },
          body: { as },
        }),
      ),
    );
  return (
    <span className="flex flex-wrap gap-2">
      {collection && (
        <button
          type="button"
          disabled={busy}
          className={buttonClass('primary')}
          onClick={() => void approve('collection')}
        >
          تأیید مدیر وصول
        </button>
      )}
      {finance && (
        <button
          type="button"
          disabled={busy}
          className={buttonClass('primary')}
          onClick={() => void approve('finance')}
        >
          تأیید مالی
        </button>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </span>
  );
}

/** Finance records the bank's answer: cleared (its tracking number) or bounced (why). */
export function RecordOutcome({ id }: { id: string }) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  const [mode, setMode] = useState<'idle' | 'cleared' | 'bounced'>('idle');
  const [day, setDay] = useState<JalaliDate | null>(null);
  const today = tehranToday();
  if (mode === 'idle') {
    return (
      <span className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass('primary')}
          onClick={() => {
            setMode('cleared');
          }}
        >
          وصول شد
        </button>
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setMode('bounced');
          }}
        >
          برگشت خورد
        </button>
      </span>
    );
  }
  return (
    <form
      className="space-y-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        if (!day) {
          setError('روز را انتخاب کنید.');
          return;
        }
        const on = apiDay(day);
        void run(() =>
          mode === 'cleared'
            ? unwrap(
                api.POST('/api/v1/instrument-executions/{id}/cleared', {
                  params: { path: { id } },
                  body: { clearedOn: on, bankRef: formText(form, 'bankRef').trim() },
                }),
              )
            : unwrap(
                api.POST('/api/v1/instrument-executions/{id}/bounced', {
                  params: { path: { id } },
                  body: {
                    bouncedOn: on,
                    reason: formText(form, 'reason') as 'insufficient_funds',
                    ...(formText(form, 'note').trim()
                      ? { note: formText(form, 'note').trim() }
                      : {}),
                  },
                }),
              ),
        );
      }}
    >
      <DateField
        mode="single"
        label={mode === 'cleared' ? 'روز وصول' : 'روز برگشت'}
        today={today}
        max={today}
        value={day}
        onChange={setDay}
      />
      {mode === 'cleared' ? (
        <TextField
          id={`bank-${id}`}
          name="bankRef"
          label="شماره پیگیری بانک"
          dir="ltr"
          figures
          required
        />
      ) : (
        <>
          <SelectField
            id={`why-${id}`}
            name="reason"
            label="دلیل برگشت"
            options={[
              { value: 'insufficient_funds', label: 'کسری موجودی' },
              { value: 'signature_mismatch', label: 'مغایرت امضا' },
              { value: 'account_closed', label: 'حساب بسته' },
              { value: 'other', label: 'دیگر' },
            ]}
          />
          <TextField id={`note-${id}`} name="note" label="توضیح" />
        </>
      )}
      <span className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ثبت
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
      </span>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/**
 * A release of an instrument of a settled loan (ADR-052): one accountant asks with a reason,
 * a second approves (released then; its owner is told by SMS) or refuses; the asker may take
 * the request back. Each signs with their own SMS code, asked for by the code dialog.
 */
export function ReleaseInstrument({
  id,
  pending,
  me,
  canRequest,
  canApprove,
}: {
  id: string;
  pending: { id: string; requestedBy: string; reason: string } | null;
  me: string;
  canRequest: boolean;
  canApprove: boolean;
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  if (!pending) {
    if (!canRequest) return <span className="text-ink-muted">—</span>;
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          void run(() =>
            unwrap(
              api.POST('/api/v1/instrument-releases/{instrumentId}/requests', {
                params: { path: { instrumentId: id } },
                body: { reason },
              }),
            ),
          );
        }}
      >
        <TextField id={`release-reason-${id}`} name="reason" label="دلیل استرداد" required />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          درخواست استرداد
        </button>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    );
  }
  const decide = (outcome: 'approved' | 'refused') =>
    void run(() =>
      unwrap(
        api.POST('/api/v1/instrument-releases/requests/{requestId}/decision', {
          params: { path: { requestId: pending.id } },
          body: outcome === 'refused' ? { outcome, reason: 'رد استرداد' } : { outcome },
        }),
      ),
    );
  return (
    <span className="space-y-1">
      <span className="block text-[length:var(--text-sm)]">درخواست‌شده: {pending.reason}</span>
      {pending.requestedBy === me ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-ink-muted">در انتظار تأیید نفر دوم</span>
          <button
            type="button"
            disabled={busy}
            className={buttonClass('quiet')}
            onClick={() =>
              void run(() =>
                unwrap(
                  api.POST('/api/v1/instrument-releases/requests/{requestId}/withdraw', {
                    params: { path: { requestId: pending.id } },
                  }),
                ),
              )
            }
          >
            پس گرفتن درخواست
          </button>
        </span>
      ) : canApprove ? (
        <span className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className={buttonClass('primary')}
            onClick={() => {
              decide('approved');
            }}
          >
            تأیید استرداد
          </button>
          <button
            type="button"
            disabled={busy}
            className={buttonClass('secondary')}
            onClick={() => {
              decide('refused');
            }}
          >
            رد
          </button>
        </span>
      ) : (
        <span className="text-ink-muted">در انتظار تأیید نفر دوم</span>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </span>
  );
}
