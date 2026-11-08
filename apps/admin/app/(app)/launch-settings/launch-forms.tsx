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
import { toPersianDigits } from '@sepehr/contracts';
import { shownValue, toConfigValue, type Bounds, type LaunchKind } from '../../../lib/launch-keys';

const FIELD: Record<Exclude<LaunchKind, 'flag'>, { label: string; hint: string }> = {
  cap: { label: 'سقف تازه (ریال)', hint: 'به ریال، بی اعشار؛ ۰ یعنی خاموش.' },
  rial: { label: 'مبلغ تازه (ریال)', hint: 'به ریال، بی اعشار؛ ۰ یعنی خاموش.' },
  count: { label: 'تعداد تازه', hint: 'عدد صحیح از ۰ تا ۱۰۰؛ ۰ یعنی خاموش.' },
  percent: { label: 'درصد تازه', hint: 'مثلاً ۱۱۰ یعنی ۱۱۰٪ مبلغ پیش‌فاکتور؛ ۰ یعنی خاموش.' },
  days: { label: 'تعداد روز تازه', hint: 'عدد صحیح روز.' },
  monthday: { label: 'روز ماه تازه', hint: 'روزی از ماه شمسی.' },
};

/** The hint for a number with its own range: the range, as the key's schema has it. */
function hintOf(kind: Exclude<LaunchKind, 'flag'>, bounds: Bounds | undefined) {
  if (!bounds) return FIELD[kind].hint;
  const [min, max] =
    kind === 'percent' ? [bounds.min / 100, bounds.max / 100] : [bounds.min, bounds.max];
  const unit = kind === 'percent' ? 'درصد' : kind === 'monthday' ? '' : 'روز';
  return `از ${toPersianDigits(String(min))} تا ${toPersianDigits(String(max))}${unit ? ` ${unit}` : ''}.`;
}

/**
 * One launch setting, typed (plan item الف): the value checked here for what a person typed,
 * then proposed through the versioned configuration; nothing changes until a second person
 * approves it, and the server checks everything again.
 */
export function ProposeLaunchValue({
  configKey,
  kind,
  current,
  bounds,
}: {
  configKey: string;
  kind: LaunchKind;
  current: unknown;
  bounds?: Bounds | undefined;
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-label="پیشنهاد مقدار تازه"
      noValidate
      onInput={(e) => {
        const field = e.target as HTMLInputElement;
        if (field.name !== 'value' || kind === 'flag') return;
        const parsed = toConfigValue(kind, field.value, current, bounds);
        setPreview(parsed.ok ? shownValue(kind, parsed.value) : null);
      }}
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const parsed = toConfigValue(kind, formText(form, 'value'), current, bounds);
        setDone(null);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        setBusy(true);
        setError(null);
        void unwrap(
          api.POST('/api/v1/config/proposals', {
            body: {
              key: configKey,
              scope: { level: 'global' },
              value: parsed.value,
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
        {kind === 'flag' ? (
          <SelectField
            id="value"
            name="value"
            label="مقدار تازه"
            defaultValue="off"
            options={[
              { value: 'off', label: 'خاموش' },
              { value: 'on', label: 'روشن' },
            ]}
          />
        ) : (
          <TextField
            id="value"
            name="value"
            label={FIELD[kind].label}
            hint={hintOf(kind, bounds)}
            inputMode="numeric"
            required
            figures
          />
        )}
        <TextField id="reason" name="reason" label="دلیل تغییر" required className="grow" />
      </div>
      {preview && <p className="text-[length:var(--text-sm)]">یعنی: {preview}</p>}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت پیشنهاد
      </button>
    </form>
  );
}
