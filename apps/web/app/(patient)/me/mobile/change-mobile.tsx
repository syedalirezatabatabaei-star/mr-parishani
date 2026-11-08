'use client';

import { unwrap } from '@sepehr/api-client';
import { normalizeMobile, toPersianDigits } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  faDigits,
  formText,
  Notice,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useState, type SubmitEvent } from 'react';

/**
 * The new mobile, then the code sent to it (ف۱۲ ب۱). The mobile is normalized before it is
 * sent (rule 24); the code may be typed in any digits. Whether the number is someone else's
 * is told only after its code.
 */
export function ChangeMobile() {
  const api = useApi();
  const [mobile, setMobile] = useState<string | null>(null);
  const [done, setDone] = useState<{ mobileLastFour: string; sessionsEnded: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST('/api/v1/me/mobile/request', { body: { mobile: value } }));
      setMobile(value);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onMobile = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = formText(e.currentTarget, 'mobile');
    if (normalizeMobile(value) === null) {
      setError('شماره موبایل درست نیست؛ مثل ۰۹۱۲۱۲۳۴۵۶۷ بنویسید.');
      return;
    }
    void request(value);
  };

  const onCode = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mobile) return;
    const code = formText(e.currentTarget, 'code');
    setBusy(true);
    setError(null);
    try {
      setDone(await unwrap(api.POST('/api/v1/me/mobile/verify', { body: { mobile, code } })));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Notice tone="success" title="شماره موبایل تغییر کرد">
        از این پس با شماره‌ای که به {faDigits(done.mobileLastFour)} ختم می‌شود وارد شوید.
        {done.sessionsEnded > 0
          ? ` ورود شما در ${toPersianDigits(String(done.sessionsEnded))} دستگاه دیگر بسته شد.`
          : ''}
      </Notice>
    );
  }

  if (mobile === null) {
    return (
      <form onSubmit={onMobile} className="space-y-4" noValidate>
        <TextField
          id="mobile"
          name="mobile"
          type="tel"
          label="شماره موبایل تازه"
          inputMode="tel"
          autoComplete="tel"
          placeholder="۰۹۱۲۱۲۳۴۵۶۷"
          dir="ltr"
          figures
          required
          error={error}
        />
        <button type="submit" disabled={busy} className={buttonClass('primary', 'w-full')}>
          دریافت کد تأیید
        </button>
      </form>
    );
  }

  const shown = toPersianDigits(`0${normalizeMobile(mobile) ?? ''}`);
  return (
    <form onSubmit={(e) => void onCode(e)} className="space-y-4" noValidate>
      <Notice tone="info">
        کد تأیید به شماره{' '}
        <span className="figures" dir="ltr">
          {shown}
        </span>{' '}
        پیامک شد.
      </Notice>
      <TextField
        id="code"
        name="code"
        label="کد تأیید"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="۶ رقم"
        dir="ltr"
        figures
        required
        error={error}
      />
      <button type="submit" disabled={busy} className={buttonClass('primary', 'w-full')}>
        تأیید و تغییر شماره
      </button>
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setMobile(null);
          setError(null);
        }}
      >
        شماره دیگر
      </button>
    </form>
  );
}
