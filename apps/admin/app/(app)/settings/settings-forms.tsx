'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * A flag turned on or off, by proposal: it changes nothing until a second person approves it
 * (every key here is sensitive; the API and the database refuse the proposer). Off is the
 * choice the form starts on. `shape` is how the key stores it: a bare boolean, or
 * `{ enabled }` with the rest of the value kept as it is.
 */
export function ProposeFlag({
  configKey,
  shape,
  current,
}: {
  configKey: string;
  shape: 'boolean' | 'enabled';
  current: unknown;
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-label="پیشنهاد روشن یا خاموش"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const on = formText(form, 'state') === 'on';
        const base =
          typeof current === 'object' && current !== null
            ? (current as Record<string, unknown>)
            : {};
        const value = shape === 'boolean' ? on : { ...base, enabled: on };
        setBusy(true);
        setError(null);
        setDone(null);
        void unwrap(
          api.POST('/api/v1/config/proposals', {
            body: {
              key: configKey,
              scope: { level: 'global' },
              value,
              reason: formText(form, 'reason'),
            },
          }),
        )
          .then(() => {
            setDone('پیشنهاد ثبت شد و منتظر تأیید نفر دوم است.');
            router.refresh();
          })
          .catch((err: unknown) => {
            setError(errorMessage(err));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          id="flag-state"
          name="state"
          label="مقدار تازه"
          defaultValue="off"
          options={[
            { value: 'off', label: 'خاموش' },
            { value: 'on', label: 'روشن' },
          ]}
        />
        <TextField id="flag-reason" name="reason" label="دلیل تغییر" required className="grow" />
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت پیشنهاد
      </button>
    </form>
  );
}
