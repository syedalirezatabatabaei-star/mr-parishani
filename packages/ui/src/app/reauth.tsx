'use client';

import { createApiClient, unwrap } from '@sepehr/api-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import { buttonClass, Notice, TextField } from '../kit/controls.js';
import { errorMessage } from './errors.js';
import { formText } from './form.js';

/** Asks the user for a TOTP code again; resolves true once accepted, false if they cancel. */
export type ReauthPrompt = () => Promise<boolean>;

export const ReauthContext = createContext<ReauthPrompt | null>(null);

/** The prompt of the nearest {@link ReauthDialog}; null outside one (no retry then). */
export const useReauthPrompt = () => useContext(ReauthContext);

/**
 * A fetch for the API client (task 9-3, R1): an answer `403 reauth_required` asks for a TOTP
 * code through `prompt`, then sends the same request again, once. A cancelled prompt, or a
 * second refusal, comes back as the API's own answer.
 */
export function reauthFetch(prompt: ReauthPrompt | null, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const retry = prompt ? request.clone() : null;
    const response = await base(request);
    if (!retry || !prompt || response.status !== 403) return response;
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown } | null;
    if (body?.error !== 'reauth_required') return response;
    if (!(await prompt())) return response;
    return base(retry);
  };
}

/**
 * The «confirm it is you» dialog (task 9-3, R1), mounted once by the API provider: a modal
 * asking for the six-digit code of the authenticator app. Opened by {@link reauthFetch};
 * the code is sent to `POST /auth/totp/reauth` and nowhere kept.
 */
export function ReauthDialog({
  csrfToken,
  children,
}: {
  csrfToken: string | null;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const prompt = useCallback<ReauthPrompt>(
    () =>
      new Promise<boolean>((resolve) => {
        // A prompt already open answers every request waiting on it.
        const earlier = pending.current;
        pending.current = (ok) => {
          earlier?.(ok);
          resolve(ok);
        };
        setError(null);
        setOpen(true);
      }),
    [],
  );

  // In the page only while asked: a hidden form would add a second «کد تأیید» field to it.
  useEffect(() => {
    const el = dialog.current;
    if (open && el && !el.open) el.showModal();
  }, [open]);

  const finish = (ok: boolean) => {
    const done = pending.current;
    pending.current = null;
    setOpen(false);
    done?.(ok);
  };

  const onSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const code = formText(form, 'code');
    setBusy(true);
    setError(null);
    const api = createApiClient({ baseUrl: '', csrfToken: () => csrfToken });
    try {
      await unwrap(api.POST('/api/v1/auth/totp/reauth', { body: { code } }));
      form.reset();
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReauthContext value={prompt}>
      {children}
      {open && (
        <dialog
          ref={dialog}
          aria-labelledby="reauth-title"
          className="m-auto w-full max-w-sm rounded-lg border border-border bg-surface p-5 text-ink backdrop:bg-black/40"
          onCancel={(e) => {
            e.preventDefault();
            finish(false);
          }}
        >
          <form className="space-y-4" noValidate onSubmit={(e) => void onSubmit(e)}>
            <h2 id="reauth-title" className="text-[length:var(--text-lg)] font-bold">
              تأیید هویت
            </h2>
            <p className="text-[length:var(--text-sm)] text-ink-muted">
              این کار حساس است. کد شش‌رقمی برنامه احراز هویت خود را دوباره وارد کنید.
            </p>
            <TextField
              id="reauth-code"
              name="code"
              label="کد تأیید"
              inputMode="numeric"
              autoComplete="one-time-code"
              dir="ltr"
              figures
              required
            />
            {error && <Notice tone="danger">{error}</Notice>}
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={buttonClass('primary')}>
                تأیید
              </button>
              <button
                type="button"
                className={buttonClass('quiet')}
                onClick={() => {
                  finish(false);
                }}
              >
                انصراف
              </button>
            </div>
          </form>
        </dialog>
      )}
    </ReauthContext>
  );
}
