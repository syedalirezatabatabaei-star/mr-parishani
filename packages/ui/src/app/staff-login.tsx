'use client';

import { ApiError, authApi, createApiClient, type TotpEnrollment } from '@sepehr/api-client';
import { buttonClass, Notice, TextField } from '../kit/controls.js';
import { useState, type SubmitEvent } from 'react';
import { encode } from 'uqr';
import { useApi } from './browser-api.js';
import { errorMessage } from './errors.js';
import { formText } from './form.js';

type Step =
  | { kind: 'password' }
  | { kind: 'totp'; csrf: string }
  | { kind: 'enroll'; csrf: string; enrollment: TotpEnrollment };

/** The otpauth URI as a QR code drawn in SVG here: no image service (rule 18). */
function QrCode({ text }: { text: string }) {
  const { data, size } = encode(text, { ecc: 'M', border: 2 });
  return (
    <svg
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      className="mx-auto size-48 rounded-md bg-white"
      role="img"
      aria-label="کد QR برای افزودن حساب به برنامه احراز هویت"
      shapeRendering="crispEdges"
    >
      {data.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? (
            <rect key={`${String(x)}-${String(y)}`} x={x} y={y} width="1" height="1" fill="#000" />
          ) : null,
        ),
      )}
    </svg>
  );
}

/**
 * Staff sign-in (rule 25): username and password, then a TOTP code; on the first sign-in
 * the authenticator app is set up first. Each step's CSRF token comes from the step before.
 */
export function StaffLogin({ next }: { next: string }) {
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const auth = authApi(useApi(step.kind === 'password' ? null : step.csrf));

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onPassword = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const result = await auth.staffLogin({
        username: formText(form, 'username'),
        password: formText(form, 'password'),
      });
      // A web sign-in always carries its CSRF token (mobile would get tokens instead).
      const csrf = result.csrfToken;
      if (!csrf) throw new ApiError(0, 'missing_csrf_token');
      // Already past TOTP: only the demo's sign-in proxy answers so (apps/e2e demo/totp-proxy.ts,
      // owner 1405/08/09); the API itself always answers mfa_pending here.
      if (result.stage === 'active') {
        window.location.assign(next);
        return;
      }
      if (result.next === 'totp') {
        setStep({ kind: 'totp', csrf });
        return;
      }
      // The next request needs the token this answer just gave.
      const enrolling = authApi(createApiClient({ baseUrl: '', csrfToken: () => csrf }));
      setStep({
        kind: 'enroll',
        csrf,
        enrollment: await enrolling.enrollTotp(),
      });
    });
  };

  const onCode = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(e.currentTarget, 'code');
    void run(async () => {
      await auth.verifyTotp(code);
      window.location.assign(next);
    });
  };

  if (step.kind === 'password') {
    return (
      <form onSubmit={onPassword} className="space-y-4" noValidate>
        <TextField
          id="username"
          name="username"
          label="نام کاربری"
          autoComplete="username"
          dir="ltr"
          required
        />
        <TextField
          id="password"
          name="password"
          type="password"
          label="رمز عبور"
          autoComplete="current-password"
          dir="ltr"
          required
          error={error}
        />
        <button type="submit" disabled={busy} className={buttonClass('primary', 'w-full')}>
          ادامه
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onCode} className="space-y-4" noValidate>
      {step.kind === 'enroll' ? (
        <div className="space-y-3">
          <Notice tone="info" title="فعال‌سازی ورود دومرحله‌ای">
            این کد را با برنامه احراز هویت گوشی خود بخوانید، سپس کد شش‌رقمی برنامه را وارد کنید.
          </Notice>
          <QrCode text={step.enrollment.otpauthUri} />
          <details className="text-[length:var(--text-sm)]">
            <summary className="cursor-pointer text-accent">نمی‌توانید کد را بخوانید؟</summary>
            <p className="mt-2">کلید را دستی وارد کنید:</p>
            <code dir="ltr" className="figures block rounded-md bg-sunken p-2 break-all select-all">
              {step.enrollment.secret}
            </code>
          </details>
        </div>
      ) : (
        <p className="text-[length:var(--text-sm)] text-ink-muted">
          کد شش‌رقمی برنامه احراز هویت خود را وارد کنید.
        </p>
      )}
      <TextField
        id="code"
        name="code"
        label="کد تأیید"
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        figures
        required
        error={error}
      />
      <button type="submit" disabled={busy} className={buttonClass('primary', 'w-full')}>
        ورود
      </button>
    </form>
  );
}
