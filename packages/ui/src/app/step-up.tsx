'use client';

import { createApiClient, unwrap } from '@sepehr/api-client';
import {
  formatToman,
  STEP_UP_HEADER,
  STEP_UP_OPERATIONS,
  stepUpOperationSchema,
  type StepUpOperation,
} from '@sepehr/contracts';
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

/**
 * ADR-052: asks the signer for the SMS code of one financial operation; resolves the value of
 * the `X-Step-Up` header (`<challenge>.<code>`), or null when they cancel.
 */
export type StepUpPrompt = (operation: StepUpOperation) => Promise<string | null>;

export const StepUpContext = createContext<StepUpPrompt | null>(null);

/** The prompt of the nearest {@link StepUpDialog}; null outside one (no retry then). */
export const useStepUpPrompt = () => useContext(StepUpContext);

/**
 * A fetch for the API client (ADR-052): an answer `403 step_up_required` names the operation;
 * the code sent for it is asked for through `prompt`, and the same request is sent again, once,
 * carrying it. A cancelled prompt, or a refusal of the code, comes back as the API's answer.
 */
export function stepUpFetch(prompt: StepUpPrompt | null, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const retry = prompt ? request.clone() : null;
    const response = await base(request);
    if (!retry || !prompt || response.status !== 403) return response;
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown; operation?: unknown } | null;
    if (body?.error !== 'step_up_required') return response;
    const operation = stepUpOperationSchema.safeParse(body.operation);
    if (!operation.success) return response;
    const proof = await prompt(operation.data);
    if (!proof) return response;
    const headers = new Headers(retry.headers);
    headers.set(STEP_UP_HEADER, proof);
    return base(new Request(retry, { headers }));
  };
}

interface Sent {
  readonly challengeId: string;
  readonly maskedMobile: string;
  readonly resendAt: number;
}

/**
 * The «SMS code» dialog of a financial signature (ADR-052), mounted once by the API provider:
 * it asks the API to send a code for the operation to the signer's own verified mobile, says
 * what is being confirmed (never a patient's name), and hands the code back for the retry. The
 * API checks it; nothing is kept here.
 */
export function StepUpDialog({
  csrfToken,
  children,
}: {
  csrfToken: string | null;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<((proof: string | null) => void) | null>(null);
  const [operation, setOperation] = useState<StepUpOperation | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const api = useCallback(
    () => createApiClient({ baseUrl: '', csrfToken: () => csrfToken }),
    [csrfToken],
  );

  const send = useCallback(
    async (op: StepUpOperation) => {
      setBusy(true);
      setError(null);
      try {
        const view = await unwrap(api().POST('/api/v1/identity/step-up/challenges', { body: op }));
        setSent({
          challengeId: view.challengeId,
          maskedMobile: view.maskedMobile,
          resendAt: Date.now() + view.resendAfterSeconds * 1000,
        });
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const prompt = useCallback<StepUpPrompt>(
    (op) =>
      new Promise<string | null>((resolve) => {
        const earlier = pending.current;
        pending.current = (proof) => {
          earlier?.(null);
          resolve(proof);
        };
        setOperation(op);
        setSent(null);
        void send(op);
      }),
    [send],
  );

  useEffect(() => {
    const el = dialog.current;
    if (operation && el && !el.open) el.showModal();
  }, [operation]);

  // The resend button's countdown.
  useEffect(() => {
    if (!sent) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [sent]);

  const finish = (proof: string | null) => {
    const done = pending.current;
    pending.current = null;
    setOperation(null);
    setSent(null);
    done?.(proof);
  };

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(e.currentTarget, 'code').replace(/[۰-۹]/g, (d) =>
      String(d.charCodeAt(0) - 0x06f0),
    );
    if (!sent) return;
    if (!/^\d{6}$/.test(code)) {
      setError('کد شش‌رقمی پیامک‌شده را وارد کنید.');
      return;
    }
    finish(`${sent.challengeId}.${code}`);
  };

  const waitSeconds = sent ? Math.max(0, Math.ceil((sent.resendAt - now) / 1000)) : 0;

  return (
    <StepUpContext value={prompt}>
      {children}
      {operation && (
        <dialog
          ref={dialog}
          aria-labelledby="step-up-title"
          className="m-auto w-full max-w-sm rounded-lg border border-border bg-surface p-5 text-ink backdrop:bg-black/40"
          onCancel={(e) => {
            e.preventDefault();
            finish(null);
          }}
        >
          <form className="space-y-4" noValidate onSubmit={onSubmit}>
            <h2 id="step-up-title" className="text-[length:var(--text-lg)] font-bold">
              کد تأیید پیامکی
            </h2>
            <p className="text-[length:var(--text-sm)]">
              {STEP_UP_OPERATIONS[operation.type]}
              {operation.amountRial !== null && (
                <>
                  {' '}
                  به مبلغ <span className="figures">{formatToman(operation.amountRial)}</span>
                </>
              )}
            </p>
            {sent ? (
              <p className="text-[length:var(--text-sm)] text-ink-muted">
                کد به شماره <span dir="ltr">{sent.maskedMobile}</span> پیامک شد. این کد را به هیچ‌کس
                ندهید.
              </p>
            ) : (
              !error && <p className="text-[length:var(--text-sm)] text-ink-muted">در حال ارسال…</p>
            )}
            <TextField
              id="step-up-code"
              name="code"
              label="کد پیامک‌شده"
              inputMode="numeric"
              autoComplete="one-time-code"
              dir="ltr"
              figures
              required
            />
            {error && <Notice tone="danger">{error}</Notice>}
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={busy || !sent} className={buttonClass('primary')}>
                تأیید
              </button>
              <button
                type="button"
                disabled={busy || waitSeconds > 0}
                className={buttonClass('secondary')}
                onClick={() => {
                  void send(operation);
                }}
              >
                {waitSeconds > 0 ? `ارسال دوباره (${String(waitSeconds)})` : 'ارسال دوباره'}
              </button>
              <button
                type="button"
                className={buttonClass('quiet')}
                onClick={() => {
                  finish(null);
                }}
              >
                انصراف
              </button>
            </div>
          </form>
        </dialog>
      )}
    </StepUpContext>
  );
}
