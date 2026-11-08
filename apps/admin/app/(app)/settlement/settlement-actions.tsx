'use client';

import { ApiError, unwrap } from '@sepehr/api-client';
import type { JalaliDate, PayoutStatus, StatementStatus } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  errorMessage,
  formText,
  Notice,
  OWN_FUNDING_REQUEST,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

/**
 * Accounting's steps on a statement and its payout orders (tasks 5-4, 5-5, 5-7). Every rule
 * (two people, items unchanged, a tracking number before paid) is the service's; these only
 * ask, and say a refusal in Persian.
 */

const actionError = (err: unknown) =>
  err instanceof ApiError && err.code === 'same_person' ? OWN_FUNDING_REQUEST : errorMessage(err);

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
      setError(actionError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/** A CSV the browser saves (the bank file, the Odoo file): data exchanged, not shown. */
export function saveCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function StatementActions({ id, status }: { id: string; status: StatementStatus }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const path = { params: { path: { id } } };
  const cancel = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = formText(e.currentTarget, 'reason');
    void run(() =>
      unwrap(api.POST('/api/v1/settlement/statements/{id}/cancel', { ...path, body: { reason } })),
    );
  };
  return (
    <section className="space-y-3" aria-label="کارهای صورت‌وضعیت">
      <div className="flex flex-wrap gap-2">
        {status === 'draft' && (
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={busy}
            onClick={() =>
              void run(() => unwrap(api.POST('/api/v1/settlement/statements/{id}/review', path)))
            }
          >
            بررسی شد
          </button>
        )}
        {status === 'reviewed' && (
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={busy}
            onClick={() =>
              void run(() => unwrap(api.POST('/api/v1/settlement/statements/{id}/approve', path)))
            }
          >
            تأیید دوم و صدور دستور پرداخت
          </button>
        )}
      </div>
      {(status === 'draft' || status === 'reviewed') && (
        <form onSubmit={cancel} className="space-y-2" aria-label="لغو صورت‌وضعیت" noValidate>
          <TextField
            id="cancel-reason"
            name="reason"
            label="دلیل لغو (با تأیید نفر دوم)"
            required
          />
          <button type="submit" className={buttonClass('danger')} disabled={busy}>
            درخواست یا تأیید لغو
          </button>
        </form>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </section>
  );
}

export function PayoutActions({
  id,
  status,
  today,
}: {
  id: string;
  status: PayoutStatus;
  today: JalaliDate;
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [paidOn, setPaidOn] = useState<JalaliDate | null>(null);
  const path = { params: { path: { id } } };
  const exportFile = () =>
    void run(async () => {
      const file = await unwrap(
        api.POST('/api/v1/settlement/payouts/export', { body: { payoutIds: [id] } }),
      );
      saveCsv(`payouts-${file.batchId}.csv`, file.csv);
    });
  const tracking = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    void run(() =>
      unwrap(
        api.POST('/api/v1/settlement/payouts/{id}/tracking', {
          ...path,
          body: { bankTrackingRef: formText(form, 'ref'), paidOn: paidOn ? apiDay(paidOn) : '' },
        }),
      ),
    );
  };
  const fail = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = formText(e.currentTarget, 'reason');
    void run(() =>
      unwrap(api.POST('/api/v1/settlement/payouts/{id}/fail', { ...path, body: { reason } })),
    );
  };
  return (
    <div className="space-y-2">
      {status === 'issued' && (
        <button
          type="button"
          className={buttonClass('secondary')}
          disabled={busy}
          onClick={exportFile}
        >
          فایل بانک
        </button>
      )}
      {status === 'sent_to_bank' && (
        <>
          <form onSubmit={tracking} className="space-y-2" aria-label="کد رهگیری بانک" noValidate>
            <TextField id={`ref-${id}`} name="ref" label="کد رهگیری بانک" dir="ltr" required />
            <DateField
              mode="single"
              label="روز پرداخت (از فیش بانک)"
              today={today}
              max={today}
              value={paidOn}
              onChange={setPaidOn}
            />
            <button type="submit" className={buttonClass('secondary')} disabled={busy}>
              ثبت کد رهگیری
            </button>
          </form>
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={busy}
            onClick={() =>
              void run(() => unwrap(api.POST('/api/v1/settlement/payouts/{id}/confirm', path)))
            }
          >
            تأیید دوم پرداخت
          </button>
        </>
      )}
      {(status === 'issued' || status === 'sent_to_bank') && (
        <form onSubmit={fail} className="space-y-2" aria-label="اعلام ناموفق" noValidate>
          <TextField id={`fail-${id}`} name="reason" label="دلیل ناموفق بودن" required />
          <button type="submit" className={buttonClass('danger')} disabled={busy}>
            اعلام یا تأیید ناموفق
          </button>
        </form>
      )}
      {status === 'failed' && (
        <button
          type="button"
          className={buttonClass('secondary')}
          disabled={busy}
          onClick={() =>
            void run(() => unwrap(api.POST('/api/v1/settlement/payouts/{id}/reissue', path)))
          }
        >
          صدور دوباره
        </button>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
