'use client';

import { unwrap } from '@sepehr/api-client';
import { normalizeMobile, toPersianDigits } from '@sepehr/contracts';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

interface Mobiles {
  currentMobile: string;
  newMobile: string;
}

/**
 * The first of the two (ف۱۲ ب۲): the patient's current and new mobiles, then the code sent to
 * the new one, which the patient reads back, with the evidence seen and a reason. The API asks
 * for the TOTP code again when re-authentication is on (R1).
 */
export function ProposeChange() {
  const api = useApi();
  const router = useRouter();
  const [mobiles, setMobiles] = useState<Mobiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState(false);

  const onMobiles = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const value = {
      currentMobile: formText(form, 'currentMobile'),
      newMobile: formText(form, 'newMobile'),
    };
    if (
      normalizeMobile(value.currentMobile) === null ||
      normalizeMobile(value.newMobile) === null
    ) {
      setError('شماره موبایل درست نیست؛ مثل ۰۹۱۲۱۲۳۴۵۶۷ بنویسید.');
      return;
    }
    setBusy(true);
    setError(null);
    setProposed(false);
    try {
      await unwrap(api.POST('/api/v1/identity/patient-mobile-changes/code', { body: value }));
      setMobiles(value);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onPropose = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mobiles) return;
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST('/api/v1/identity/patient-mobile-changes', {
          body: {
            ...mobiles,
            code: formText(form, 'code'),
            evidence: formText(form, 'evidence'),
            reason: formText(form, 'reason'),
          },
        }),
      );
      setMobiles(null);
      setProposed(true);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (mobiles === null) {
    return (
      <form onSubmit={(e) => void onMobiles(e)} className="space-y-3" noValidate>
        {proposed ? (
          <Notice tone="success">پیشنهاد ثبت شد و منتظر تأیید همکار دیگر است.</Notice>
        ) : null}
        <TextField
          id="currentMobile"
          name="currentMobile"
          type="tel"
          label="شماره فعلی بیمار (گم‌شده)"
          inputMode="tel"
          placeholder="۰۹۱۲۱۲۳۴۵۶۷"
          dir="ltr"
          figures
          required
        />
        <TextField
          id="newMobile"
          name="newMobile"
          type="tel"
          label="شماره تازه بیمار"
          inputMode="tel"
          placeholder="۰۹۱۲۱۲۳۴۵۶۷"
          dir="ltr"
          figures
          required
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ارسال کد به شماره تازه
        </button>
      </form>
    );
  }

  const shown = toPersianDigits(`0${normalizeMobile(mobiles.newMobile) ?? ''}`);
  return (
    <form onSubmit={(e) => void onPropose(e)} className="space-y-3" noValidate>
      <Notice tone="info">
        کد به شماره{' '}
        <span className="figures" dir="ltr">
          {shown}
        </span>{' '}
        پیامک شد. آن را از بیمار بپرسید.
      </Notice>
      <TextField
        id="code"
        name="code"
        label="کدی که بیمار خواند"
        inputMode="numeric"
        autoComplete="off"
        placeholder="۶ رقم"
        dir="ltr"
        figures
        required
      />
      <TextField
        id="evidence"
        name="evidence"
        label="مدرکی که دیدید"
        hint="مثلاً «کارت ملی حضوری در شعبه، ۱۴۰۵/۰۷/۲۶». همکار دیگری باید تأیید کند."
        required
      />
      <TextField id="reason" name="reason" label="دلیل" required />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ثبت پیشنهاد
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setMobiles(null);
            setError(null);
          }}
        >
          انصراف
        </button>
      </div>
    </form>
  );
}
