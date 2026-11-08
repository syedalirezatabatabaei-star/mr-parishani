'use client';

import { authApi } from '@sepehr/api-client';
import { normalizeMobile, toPersianDigits } from '@sepehr/contracts';
import { buttonClass, errorMessage, Glyph, useApi } from '@sepehr/ui';
import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';

const STEPS = ['شماره موبایل', 'کد تأیید', 'آماده'] as const;
/** How long «آماده» shows before the page the visitor came for. */
const READY_MS = 900;

/** The three steps, the current marked for sight and for screen readers. */
function Progress({ step }: { step: 0 | 1 | 2 }) {
  return (
    <ol aria-label="مراحل ورود" className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const done = i < step;
        const here = i === step;
        return (
          <li
            key={label}
            aria-current={here ? 'step' : undefined}
            className="flex flex-1 flex-col items-center gap-1 text-center"
          >
            <span
              className={`figures grid size-8 place-items-center rounded-full text-[length:var(--text-sm)] font-bold transition-colors ${
                done || here ? 'bg-accent text-on-accent' : 'bg-sunken text-ink-muted'
              }`}
            >
              {done ? (
                <Glyph name="badgeCheck" className="size-4" />
              ) : (
                toPersianDigits(String(i + 1))
              )}
            </span>
            <span
              className={`text-[length:var(--text-xs)] ${here ? 'font-bold text-ink' : 'text-ink-muted'}`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Six boxes over one real field: typing fills them in turn, pasting a code fills them all. */
function CodeBoxes({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const digits = value.padEnd(6, ' ').slice(0, 6).split('');
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[length:var(--text-sm)] font-medium">
        کد ورود
      </label>
      <div className="relative" dir="ltr">
        <div aria-hidden="true" className="grid grid-cols-6 gap-2">
          {digits.map((d, i) => (
            <span
              key={i}
              className={`figures grid h-14 place-items-center rounded-md border-2 bg-surface text-[length:var(--text-xl)] font-bold ${
                i === Math.min(value.length, 5) ? 'border-accent' : 'border-border-strong'
              } ${error ? 'border-danger' : ''}`}
            >
              {d.trim() ? toPersianDigits(d) : ''}
            </span>
          ))}
        </div>
        <input
          ref={input}
          id={id}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={12}
          aria-describedby={error ? `${id}-error` : undefined}
          aria-invalid={error ? true : undefined}
          value={toPersianDigits(value)}
          onChange={(e) => {
            const ascii = e.target.value
              .replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
              .replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
              .replace(/\D/g, '')
              .slice(0, 6);
            onChange(ascii);
          }}
          // The field itself is see-through over the boxes, so the focus ring shows on them.
          className="absolute inset-0 h-14 w-full cursor-text rounded-md text-transparent caret-transparent opacity-0 focus-visible:opacity-100 focus-visible:outline-3 focus-visible:outline-focus"
        />
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-[length:var(--text-sm)] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Patient sign-in or sign-up with a one-time code by SMS (rule 25), in three steps (owner
 * 1405/08/11: mobile, code, ready). The flow is the same as before: the mobile normalized before
 * it is sent (rule 24), the API's rate limits, an account made by the first correct code. After
 * «آماده» the page is loaded afresh, so the server pages read the new session.
 */
export function OtpLogin({ next }: { next: string }) {
  const auth = authApi(useApi());
  const [typed, setTyped] = useState('');
  const [mobile, setMobile] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const mobileId = useId();

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => {
      setResendIn((s) => s - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [resendIn]);

  const request = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const sent = await auth.requestOtp({ mobile: value });
      setMobile(value);
      setCode('');
      setResendIn(sent.resendAfterSeconds);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onMobile = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const normalized = normalizeMobile(typed);
    if (normalized === null) {
      setError('شماره موبایل درست نیست؛ مثل ۰۹۱۲۱۲۳۴۵۶۷ بنویسید.');
      return;
    }
    void request(normalized);
  };

  const onCode = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mobile) return;
    if (code.length !== 6) {
      setError('کد شش‌رقمی پیامک‌شده را بنویسید.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.verifyOtp({ mobile, code });
      setReady(true);
      setTimeout(() => {
        window.location.assign(next);
      }, READY_MS);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (ready) {
    return (
      <div className="space-y-6">
        <Progress step={2} />
        <div key="ready" role="status" className="step-in space-y-3 py-4 text-center">
          <span className="mx-auto grid size-16 place-items-center rounded-full bg-accent text-on-accent">
            <Glyph name="badgeCheck" className="size-9" />
          </span>
          <p className="text-[length:var(--text-lg)] font-bold">آماده است</p>
          <p className="text-[length:var(--text-sm)] text-ink-muted">
            خوش آمدید؛ به صفحه بعد می‌رویم…
          </p>
        </div>
      </div>
    );
  }

  if (mobile === null) {
    return (
      <div className="space-y-6">
        <Progress step={0} />
        <form key="mobile" onSubmit={onMobile} className="step-in space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor={mobileId} className="block text-[length:var(--text-sm)] font-medium">
              شماره موبایل
            </label>
            <div
              dir="ltr"
              className={`flex min-h-12 items-center overflow-hidden rounded-md border bg-surface focus-within:outline-3 focus-within:outline-focus ${
                error ? 'border-danger' : 'border-border-strong'
              }`}
            >
              <span className="figures flex h-full items-center border-e border-border bg-sunken px-3 text-ink-muted">
                +۹۸
              </span>
              <input
                id={mobileId}
                name="mobile"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="۰۹۱۲ ۱۲۳ ۴۵۶۷"
                aria-describedby={error ? `${mobileId}-error` : `${mobileId}-hint`}
                aria-invalid={error ? true : undefined}
                value={toPersianDigits(typed)}
                onChange={(e) => {
                  setTyped(e.target.value);
                }}
                className="figures min-h-12 flex-1 bg-transparent px-3 text-[length:var(--text-lg)] tracking-wide outline-none"
              />
            </div>
            {error ? (
              <p
                id={`${mobileId}-error`}
                role="alert"
                className="text-[length:var(--text-sm)] text-danger"
              >
                {error}
              </p>
            ) : (
              <p id={`${mobileId}-hint`} className="text-[length:var(--text-xs)] text-ink-subtle">
                کد ورود به همین شماره پیامک می‌شود.
              </p>
            )}
          </div>
          <button type="submit" disabled={busy} className={buttonClass('primary', 'w-full')}>
            دریافت کد ورود
          </button>
        </form>
      </div>
    );
  }

  const shown = toPersianDigits(`0${mobile}`);
  return (
    <div className="space-y-6">
      <Progress step={1} />
      <form key="code" onSubmit={(e) => void onCode(e)} className="step-in space-y-4" noValidate>
        <p className="text-[length:var(--text-sm)] text-ink-muted">
          کد ورود به شماره{' '}
          <bdi className="figures font-bold text-ink" dir="ltr">
            {shown}
          </bdi>{' '}
          پیامک شد.
        </p>
        <CodeBoxes value={code} error={error} onChange={setCode} />
        <button type="submit" disabled={busy} className={buttonClass('primary', 'w-full')}>
          ورود
        </button>
        <div className="flex flex-wrap justify-between gap-2 text-[length:var(--text-sm)]">
          <button
            type="button"
            className={buttonClass('quiet')}
            onClick={() => {
              setMobile(null);
              setError(null);
            }}
          >
            تغییر شماره
          </button>
          <button
            type="button"
            className={buttonClass('quiet')}
            disabled={busy || resendIn > 0}
            onClick={() => void request(mobile)}
          >
            {resendIn > 0
              ? `ارسال دوباره تا ${toPersianDigits(String(resendIn))} ثانیه دیگر`
              : 'ارسال دوباره کد'}
          </button>
        </div>
      </form>
    </div>
  );
}
