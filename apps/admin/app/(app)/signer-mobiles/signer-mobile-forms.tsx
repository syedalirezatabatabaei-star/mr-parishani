'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

/** The account by its username, then the new number and why (ADR-052). */
export function AskChange() {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const account = await unwrap(
        api.GET('/api/v1/access/accounts/by-username/{username}', {
          params: { path: { username: formText(form, 'username') } },
        }),
      );
      await unwrap(
        api.POST('/api/v1/identity/staff-mobile-changes', {
          body: {
            accountId: account.id,
            mobile: formText(form, 'mobile'),
            reason: formText(form, 'reason'),
          },
        }),
      );
      form.reset();
      setDone(true);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
      <TextField
        id="signer-username"
        name="username"
        label="نام کاربری امضاکننده"
        dir="ltr"
        required
      />
      <TextField
        id="signer-mobile"
        name="mobile"
        label="شماره همراه تازه"
        inputMode="tel"
        dir="ltr"
        figures
        required
      />
      <TextField id="signer-reason" name="reason" label="دلیل" required />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {done ? <Notice tone="success">درخواست ثبت شد؛ منتظر دو تأیید.</Notice> : null}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت درخواست
      </button>
    </form>
  );
}

/** One of the two approvals, or a refusal that ends the request; never by its owner. */
export function DecideChange({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = (outcome: 'approved' | 'refused') => {
    setBusy(true);
    setError(null);
    void unwrap(
      api.POST('/api/v1/identity/staff-mobile-changes/{id}/decisions', {
        params: { path: { id } },
        body: outcome === 'refused' ? { outcome, reason: 'تأیید نشد' } : { outcome },
      }),
    )
      .then(() => {
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <span className="space-y-1">
      <span className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={buttonClass('primary')}
          onClick={() => {
            decide('approved');
          }}
        >
          تأیید
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
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </span>
  );
}
