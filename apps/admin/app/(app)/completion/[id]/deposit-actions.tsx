'use client';

import { unwrap } from '@sepehr/api-client';
import type { JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  defined,
  errorMessage,
  formText,
  Notice,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

function useSubmit() {
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

/**
 * The formation deposit's details (owner 1405/07/29, answer f): the amount comes from the
 * configuration and is locked by the API; case completion enters only the day and the bank's
 * tracking number. No ledger row in the pilot.
 */
export function RecordFormationDeposit({
  applicationId,
  today,
}: {
  applicationId: string;
  today: JalaliDate;
}) {
  const api = useApi();
  const { error, setError, busy, run } = useSubmit();
  const [paidOn, setPaidOn] = useState<JalaliDate | null>(null);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!paidOn) {
      setError('روز پرداخت بیعانه را انتخاب کنید.');
      return;
    }
    const form = e.currentTarget;
    const note = formText(form, 'note').trim();
    void run(() =>
      unwrap(
        api.POST('/api/v1/credit/applications/{id}/formation-deposit', {
          params: { path: { id: applicationId } },
          body: {
            paidOn: apiDay(paidOn),
            bankReference: formText(form, 'reference'),
            ...defined({ note: note ? note : undefined }),
          },
        }),
      ),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="ثبت بیعانه تشکیل" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <DateField
          mode="single"
          label="روز پرداخت بیعانه"
          today={today}
          max={today}
          value={paidOn}
          onChange={(d) => {
            setPaidOn(d);
            setError(null);
          }}
        />
        <TextField
          id={`deposit-${applicationId}-reference`}
          name="reference"
          label="شماره پیگیری بانک"
          dir="ltr"
          figures
          autoComplete="off"
          required
        />
        <TextField id={`deposit-${applicationId}-note`} name="note" label="یادداشت (اختیاری)" />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت بیعانه
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/** Its refund, before the introduction letter (the purse's charge, by default). */
export function RecordFormationDepositRefund({
  applicationId,
  today,
}: {
  applicationId: string;
  today: JalaliDate;
}) {
  const api = useApi();
  const { error, setError, busy, run } = useSubmit();
  const [refundedOn, setRefundedOn] = useState<JalaliDate | null>(null);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!refundedOn) {
      setError('روز برگشت بیعانه را انتخاب کنید.');
      return;
    }
    const form = e.currentTarget;
    void run(() =>
      unwrap(
        api.POST('/api/v1/credit/applications/{id}/formation-deposit/refund', {
          params: { path: { id: applicationId } },
          body: {
            refundedOn: apiDay(refundedOn),
            refundReference: formText(form, 'refund-reference'),
            reason: formText(form, 'refund-reason'),
          },
        }),
      ),
    );
  };
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer">ثبت برگشت بیعانه</summary>
      <form onSubmit={submit} className="mt-3 space-y-3" aria-label="ثبت برگشت بیعانه" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <DateField
            mode="single"
            label="روز برگشت"
            today={today}
            max={today}
            value={refundedOn}
            onChange={(d) => {
              setRefundedOn(d);
              setError(null);
            }}
          />
          <TextField
            id={`deposit-${applicationId}-refund-reference`}
            name="refund-reference"
            label="شماره پیگیری برگشت"
            dir="ltr"
            figures
            autoComplete="off"
            required
          />
          <TextField
            id={`deposit-${applicationId}-refund-reason`}
            name="refund-reason"
            label="دلیل برگشت"
            required
          />
        </div>
        <button type="submit" disabled={busy} className={buttonClass('secondary')}>
          ثبت برگشت
        </button>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </details>
  );
}
