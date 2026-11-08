'use client';

import { unwrap } from '@sepehr/api-client';
import { useState } from 'react';
import { buttonClass, Notice, TextField } from '../kit/controls.js';
import { useApi } from './browser-api.js';
import { errorMessage } from './errors.js';
import { formText } from './form.js';

/**
 * A staff or center user's own mobile, in two steps: the mobile, then the code sent to it
 * (task 4-6, owner: by OTP only). Shared by the center panel's account page and the internal
 * panel's required form (task 9-3, owner's question 3); `onVerified` refreshes the page.
 */
export function VerifyMobile({
  verified,
  onVerified,
}: {
  verified: boolean;
  onVerified: () => void;
}) {
  const api = useApi();
  const [mobile, setMobile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, then: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      then();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (mobile === null) {
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label="ثبت موبایل حساب"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const typed = formText(e.currentTarget, 'mobile');
          void run(
            () => unwrap(api.POST('/api/v1/auth/mobile/request', { body: { mobile: typed } })),
            () => {
              setMobile(typed);
            },
          );
        }}
      >
        <TextField
          id="account-mobile"
          name="mobile"
          label={verified ? 'موبایل تازه' : 'موبایل'}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          figures
          required
        />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ارسال کد
        </button>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label="تأیید موبایل با کد"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const code = formText(e.currentTarget, 'code');
        void run(
          () => unwrap(api.POST('/api/v1/auth/mobile/verify', { body: { mobile, code } })),
          () => {
            setMobile(null);
            onVerified();
          },
        );
      }}
    >
      <TextField
        id="account-mobile-code"
        name="code"
        label="کد پیامک‌شده"
        inputMode="numeric"
        autoComplete="one-time-code"
        figures
        required
      />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        تأیید موبایل
      </button>
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setMobile(null);
        }}
      >
        انصراف
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
