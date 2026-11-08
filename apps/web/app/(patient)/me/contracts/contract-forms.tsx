'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

type Role = 'borrower' | 'guarantor';

/** The contract's PDF, through a short signed link; every view is logged (doc 04 §7). */
export function ViewContract({ id }: { id: string }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await unwrap(
        api.GET('/api/v1/me/contracts/{id}/link', { params: { path: { id } } }),
      );
      window.open(link.url, '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('secondary')}
        onClick={() => void open()}
      >
        مشاهده متن قرارداد (PDF)
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

const ROLE_TITLE: Readonly<Record<Role, string>> = {
  borrower: 'پذیرش قرارداد به‌عنوان وام‌گیرنده',
  guarantor: 'پذیرش قرارداد به‌عنوان ضامن',
};

/**
 * Electronic acceptance by the party themselves, with a code sent to their own mobile
 * (doc 12 §2; task 4-1). It does not replace the signed paper (doc 13, open item 4).
 */
export function AcceptContract({ id, role }: { id: string; role: Role }) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const run = async (action: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(e.currentTarget, 'code');
    void run(
      () =>
        unwrap(
          api.POST('/api/v1/me/contracts/{id}/acceptance', {
            params: { path: { id } },
            body: { role, code },
          }),
        ),
      () => {
        router.refresh();
      },
    );
  };
  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-surface p-4"
      aria-labelledby={`accept-${role}`}
    >
      <h2 id={`accept-${role}`} className="font-bold">
        {ROLE_TITLE[role]}
      </h2>
      <p className="text-[length:var(--text-sm)]">
        متن قرارداد را بخوانید. با وارد کردن کد پیامک‌شده، پذیرش شما با زمان و نسخه همین متن ثبت
        می‌شود. نسخه امضاشده کاغذی هم لازم است.
      </p>
      {!sent ? (
        <button
          type="button"
          disabled={busy}
          className={buttonClass('secondary')}
          onClick={() =>
            void run(
              () =>
                unwrap(
                  api.POST('/api/v1/me/contracts/{id}/acceptance/request', {
                    params: { path: { id } },
                    body: { role },
                  }),
                ),
              () => {
                setSent(true);
              },
            )
          }
        >
          ارسال کد پذیرش به موبایل من
        </button>
      ) : (
        <form onSubmit={submit} className="space-y-2" noValidate>
          <TextField
            id={`accept-code-${role}`}
            name="code"
            label="کد پیامک‌شده"
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            figures
            required
          />
          <button type="submit" disabled={busy} className={buttonClass('primary')}>
            قرارداد را می‌پذیرم
          </button>
        </form>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}
