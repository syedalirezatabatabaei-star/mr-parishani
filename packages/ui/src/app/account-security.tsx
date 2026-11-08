'use client';

import { unwrap } from '@sepehr/api-client';
import { useEffect, useState, type SubmitEvent } from 'react';
import { buttonClass, Notice } from '../kit/controls.js';
import { showInstant } from '../kit/format.js';
import { useApi } from './browser-api.js';
import { errorMessage } from './errors.js';
import { formText } from './form.js';

type SessionRow = {
  id: string;
  client: 'web' | 'mobile';
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

const PASSWORD_INPUT =
  'block min-h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink';

/** A password field with a button that shows what was typed (ASVS 2.1.12). */
function PasswordField({ id, name, label }: { id: string; name: string; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[length:var(--text-sm)] font-medium text-ink">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          name={name}
          type={shown ? 'text' : 'password'}
          autoComplete={name === 'currentPassword' ? 'current-password' : 'new-password'}
          dir="ltr"
          required
          className={PASSWORD_INPUT}
        />
        <button
          type="button"
          className={buttonClass('quiet')}
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => {
            setShown((s) => !s);
          }}
        >
          {shown ? 'پنهان' : 'نمایش'}
        </button>
      </div>
    </div>
  );
}

/**
 * A staff member's own account security (task 9-3, R2): the password changed with the
 * current one (the other sessions end), and the sessions open now, each one can be ended.
 */
export function AccountSecurity() {
  const api = useApi();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    unwrap(api.GET('/api/v1/auth/sessions'))
      .then((rows) => {
        setSessions(rows);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  const change = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const currentPassword = formText(form, 'currentPassword');
    const newPassword = formText(form, 'newPassword');
    if (newPassword !== formText(form, 'repeatPassword')) {
      setError('گذرواژه تازه و تکرار آن یکی نیستند.');
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    void unwrap(api.POST('/api/v1/auth/password', { body: { currentPassword, newPassword } }))
      .then((r) => {
        form.reset();
        setDone(
          r.otherSessionsEnded > 0
            ? 'گذرواژه عوض شد و نشست‌های دیگر شما بسته شدند.'
            : 'گذرواژه عوض شد.',
        );
        return load();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const end = (id: string) => {
    void unwrap(api.DELETE('/api/v1/auth/sessions/{id}', { params: { path: { id } } }))
      .then(() => load())
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <h2 className="font-bold text-ink">تغییر گذرواژه</h2>
        <form onSubmit={change} className="space-y-3" aria-label="تغییر گذرواژه" noValidate>
          <PasswordField id="current-password" name="currentPassword" label="گذرواژه فعلی" />
          <PasswordField id="new-password" name="newPassword" label="گذرواژه تازه" />
          <PasswordField id="repeat-password" name="repeatPassword" label="تکرار گذرواژه تازه" />
          <p className="text-[length:var(--text-xs)] text-ink-subtle">
            دست‌کم ۱۲ نویسه؛ عبارتی بلند و به‌یادماندنی بهتر از رمز کوتاه و پیچیده است.
          </p>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {done ? <Notice tone="success">{done}</Notice> : null}
          <button type="submit" disabled={busy} className={buttonClass('primary')}>
            تغییر گذرواژه
          </button>
        </form>
      </section>
      <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <h2 className="font-bold text-ink">نشست‌های باز</h2>
        {sessions === null ? (
          <p role="status" className="text-ink-muted">
            در حال خواندن…
          </p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[length:var(--text-sm)]">
                  {s.client === 'web' ? 'مرورگر' : 'موبایل'}
                  {s.deviceLabel ? `، ${s.deviceLabel.slice(0, 60)}` : ''} — آخرین فعالیت{' '}
                  {showInstant(s.lastSeenAt)}
                  {s.current ? ' (همین نشست)' : ''}
                </span>
                {!s.current && (
                  <button
                    type="button"
                    className={buttonClass('quiet')}
                    onClick={() => {
                      end(s.id);
                    }}
                  >
                    بستن
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
