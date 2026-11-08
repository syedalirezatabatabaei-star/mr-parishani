'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  showInstant,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useEffect, useState, type SubmitEvent } from 'react';

type State =
  | { kind: 'checking' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready'; token: string; username: string; expiresAt: string }
  | { kind: 'done'; username: string };

/**
 * The one-time link's page (owner 1405/08/10): the token comes after `#`, so no server ever
 * logs it. The link is checked, then the user sets their own password; the authenticator app
 * is set up at the first sign-in, as for every center user.
 */
export function SetupForm() {
  const api = useApi(null);
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = window.location.hash.slice(1);
    let live = true;
    void unwrap(api.POST('/api/v1/auth/setup/check', { body: { token } }))
      .then((view) => {
        if (live) setState({ kind: 'ready', token, ...view });
      })
      .catch((e: unknown) => {
        if (live) setState({ kind: 'invalid', message: errorMessage(e) });
      });
    return () => {
      live = false;
    };
  }, [api]);

  if (state.kind === 'checking') {
    return <p className="text-ink-muted">پیوند بررسی می‌شود…</p>;
  }
  if (state.kind === 'invalid') {
    return <Notice tone="danger">{state.message}</Notice>;
  }
  if (state.kind === 'done') {
    return (
      <div className="space-y-4">
        <Notice tone="success" title="رمز شما ساخته شد">
          با نام کاربری <bdi dir="ltr">{state.username}</bdi> وارد شوید. در اولین ورود، برنامه احراز
          هویت گوشی را فعال می‌کنید.
        </Notice>
        <a href="/panel/login" className={buttonClass('primary', 'w-full')}>
          ورود به پنل مرکز
        </a>
      </div>
    );
  }

  const ready = state;
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = formText(form, 'password');
    if (password !== formText(form, 'repeat')) {
      setError('دو رمز یکسان نیستند.');
      return;
    }
    setBusy(true);
    setError(null);
    void unwrap(api.POST('/api/v1/auth/setup/password', { body: { token: ready.token, password } }))
      .then((r) => {
        setState({ kind: 'done', username: r.username });
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label="ساخت رمز">
      <p className="text-[length:var(--text-sm)] text-ink-muted">
        نام کاربری:{' '}
        <bdi dir="ltr" className="font-bold text-ink">
          {ready.username}
        </bdi>{' '}
        · این پیوند تا <span className="figures">{showInstant(ready.expiresAt)}</span> معتبر است.
      </p>
      <TextField
        id="password"
        name="password"
        type="password"
        label="رمز تازه"
        autoComplete="new-password"
        dir="ltr"
        hint="دست‌کم ۱۲ نویسه؛ نه فقط رقم، نه نام کاربری."
        required
      />
      <TextField
        id="repeat"
        name="repeat"
        type="password"
        label="تکرار رمز"
        autoComplete="new-password"
        dir="ltr"
        required
        error={error}
      />
      <button type="submit" disabled={busy} className={buttonClass('primary', 'w-full')}>
        ساخت رمز
      </button>
    </form>
  );
}
