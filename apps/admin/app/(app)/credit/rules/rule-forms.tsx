'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  formText,
  inputClass,
  Notice,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await action();
      setDone(success);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, done, busy, run };
}

/** The second person approves or rejects a proposed value (doc 04 §5); never their own. */
export function ProposalDecision({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const path = { params: { path: { id } } };
  return (
    <span className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('secondary')}
        onClick={() =>
          void run(
            () => unwrap(api.POST('/api/v1/config/proposals/{id}/approve', path)),
            'تأیید شد.',
          )
        }
      >
        تأیید
      </button>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('quiet')}
        onClick={() =>
          void run(() => unwrap(api.POST('/api/v1/config/proposals/{id}/reject', path)), 'رد شد.')
        }
      >
        رد
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </span>
  );
}

/**
 * A new value, as JSON, from the one in force, with a reason. The API checks it against
 * the key's schema (and, for the scoring rules, the golden cases) and holds it until a
 * second person approves it.
 */
export function ProposeValue({ configKey, initial }: { configKey: string; initial: string }) {
  const api = useApi();
  const { error, done, busy, run } = useAction();
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    let value: unknown;
    try {
      value = JSON.parse(formText(form, 'value')) as unknown;
    } catch {
      setProblem('مقدار JSON درست نیست.');
      return;
    }
    setProblem(null);
    void run(
      () =>
        unwrap(
          api.POST('/api/v1/config/proposals', {
            body: {
              key: configKey,
              scope: { level: 'global' },
              value,
              reason: formText(form, 'reason'),
            },
          }),
        ),
      'پیشنهاد ثبت شد و منتظر تأیید نفر دوم است.',
    );
  };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="space-y-1">
        <label htmlFor="value" className="block text-[length:var(--text-sm)] font-medium">
          مقدار تازه (JSON)
        </label>
        <textarea
          id="value"
          name="value"
          rows={16}
          dir="ltr"
          defaultValue={initial}
          className={`${inputClass} font-mono`}
        />
      </div>
      <TextField id="reason" name="reason" label="دلیل تغییر" required />
      {problem && <Notice tone="danger">{problem}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت پیشنهاد
      </button>
    </form>
  );
}
