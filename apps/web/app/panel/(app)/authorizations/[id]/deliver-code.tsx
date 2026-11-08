'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, faDigits, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/** Owner, task 4-6 پ۵: a new code no sooner than this. */
const RESEND_WAIT_SECONDS = 60;

/**
 * The patient's code, typed by the doctor or secretary and sent once (doc 12 §6). The field
 * is cleared after every try; the code is never kept, shown or logged. A new code no
 * sooner than 60 s apart, three in all (the API counts; the page only waits with it).
 */
export function DeliverCode({ id, sendsLeft }: { id: string; sendsLeft: number }) {
  const api = useApi();
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(RESEND_WAIT_SECONDS);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => {
      setWait((w) => w - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [wait]);

  const deliver = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST('/api/v1/service/authorizations/{id}/deliver', {
          params: { path: { id } },
          body: { code },
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      form.current?.reset();
      setBusy(false);
      router.refresh();
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST('/api/v1/service/authorizations/{id}/resend', { params: { path: { id } } }),
      );
      setWait(RESEND_WAIT_SECONDS);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      router.refresh();
    }
  };

  return (
    <div className="space-y-3">
      <form
        ref={form}
        className="flex flex-wrap items-end gap-2"
        aria-label="ثبت خدمت با کد بیمار"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const value = new FormData(e.currentTarget).get('code');
          void deliver(typeof value === 'string' ? value : '');
        }}
      >
        <TextField
          id={`code-${id}`}
          name="code"
          label="کد پیامک‌شده به بیمار"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
        />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ثبت خدمت
        </button>
      </form>
      {sendsLeft > 0 && (
        <button
          type="button"
          disabled={busy || wait > 0}
          className={buttonClass('secondary')}
          onClick={() => void resend()}
        >
          {wait > 0 ? `ارسال دوباره کد (${faDigits(wait)} ثانیه)` : 'ارسال دوباره کد'}
        </button>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
