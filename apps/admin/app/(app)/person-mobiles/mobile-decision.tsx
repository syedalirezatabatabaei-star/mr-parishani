'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

type Decision = 'propose' | 'approve' | 'reject';

/**
 * Staff's decision on one pending mobile (task 9-3, method ب; two people, owner 1405/07/23):
 * the first proposes with the reason and the evidence seen (e.g. the national card in person);
 * a second approves with a reason; refusing takes one, with the reason. The API refuses the
 * proposer approving and asks for the TOTP code again when re-authentication is on (R1).
 */
export function MobileDecision({ id, proposed }: { id: string; proposed: boolean }) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!open) return;
    const form = e.currentTarget;
    const reason = formText(form, 'reason');
    setBusy(true);
    setError(null);
    try {
      const path = { id };
      if (open === 'propose') {
        await unwrap(
          api.POST('/api/v1/lead/person-mobiles/{id}/propose', {
            params: { path },
            body: { reason, evidence: formText(form, 'evidence') },
          }),
        );
      } else if (open === 'approve') {
        await unwrap(
          api.POST('/api/v1/lead/person-mobiles/{id}/approve', {
            params: { path },
            body: { reason },
          }),
        );
      } else {
        await unwrap(
          api.POST('/api/v1/lead/person-mobiles/{id}/reject', {
            params: { path },
            body: { reason },
          }),
        );
      }
      // Decided, the mobile leaves the queue: back to it. Proposed, it waits for the second.
      if (open === 'propose') router.refresh();
      else router.push('/person-mobiles');
      setOpen(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setOpen(proposed ? 'approve' : 'propose');
          }}
        >
          {proposed ? 'تأیید نفر دوم' : 'پیشنهاد تأیید با مدرک'}
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setOpen('reject');
          }}
        >
          رد
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2" noValidate>
      <TextField id={`reason-${id}`} name="reason" label="دلیل" required />
      {open === 'propose' ? (
        <TextField
          id={`evidence-${id}`}
          name="evidence"
          label="مدرکی که دیدید"
          hint="مثلاً «کارت ملی حضوری، ۱۴۰۵/۰۷/۲۰». کسی که این شماره را افزوده نمی‌تواند تأییدش کند."
          required
        />
      ) : null}
      {open === 'approve' ? (
        <Notice tone="info">
          تأیید دونفره است: کسی که پیشنهاد داده یا شماره را افزوده نمی‌تواند تأییدش کند.
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className={buttonClass(open === 'reject' ? 'danger' : 'primary')}
        >
          {open === 'propose' ? 'ثبت پیشنهاد' : open === 'approve' ? 'تأیید' : 'رد'}
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setOpen(null);
          }}
        >
          انصراف
        </button>
      </div>
    </form>
  );
}
