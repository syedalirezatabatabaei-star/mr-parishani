'use client';

import { ApiError, unwrap } from '@sepehr/api-client';
import { fromJalali, toPersianDigits, type JalaliDate } from '@sepehr/contracts';
import {
  buttonClass,
  DateField,
  errorMessage,
  formText,
  Notice,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** What the API's refusals of these two keys mean, in Persian (the general ones: errorMessage). */
export function proposalError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as {
      details?: { failed?: number; of?: number; plans?: string[] };
    } | null;
    const details = body?.details;
    if (error.code === 'golden_cases_failed') {
      return `سامانه این قواعد را نپذیرفت: با آن‌ها ${toPersianDigits(details?.failed ?? 0)} مورد از ${toPersianDigits(details?.of ?? 0)} مورد نمونه فایل اکسل کارفرما نتیجه دیگری می‌گیرد (سند ۰۳ §۸-۳).`;
    }
    if (error.code === 'plan_rounding_required') {
      return `طرح تازه باید به تومان کامل گرد شود: ${(details?.plans ?? []).join('، ')}`;
    }
    if (error.code === 'invalid_value')
      return 'سامانه این مقدار را با قالب طرح‌ها یا قواعد نپذیرفت.';
  }
  return errorMessage(error);
}

/**
 * The second half of each editor: the changes said in Persian, what keeps the value back, and
 * the proposal with its reason (and, for the plans, the day it applies from). Nothing changes
 * until a second person approves it (doc 04 §5); the server checks everything again.
 */
export function ProposalForm({
  configKey,
  value,
  changes,
  problems,
  warning,
  withEffectiveDay,
  today,
}: {
  configKey: string;
  value: unknown;
  changes: readonly string[];
  problems: readonly string[];
  /** Said before sending, without stopping it: the server has the last word. */
  warning?: string | null | undefined;
  withEffectiveDay?: boolean;
  today: JalaliDate;
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [from, setFrom] = useState<JalaliDate | null>(null);
  const blocked = problems.length > 0 || changes.length === 0;
  return (
    <form
      aria-label="پیشنهاد مقدار تازه"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        const form = e.currentTarget;
        // Today, or no day: from the approval. A later day: from its start, Tehran time.
        const later = from && fromJalali(from) > new Date() ? fromJalali(from) : null;
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
              ...(later ? { effectiveFrom: later.toISOString() } : {}),
            },
          }),
        )
          .then(() => {
            setDone('پیشنهاد ثبت شد و منتظر تأیید مدیر استراتژی دیگری است.');
            router.refresh();
          })
          .catch((err: unknown) => {
            setError(proposalError(err));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <h2 className="font-bold">تغییرات نسبت به مقدار جاری</h2>
      {changes.length === 0 ? (
        <p>تغییری نیست.</p>
      ) : (
        <ul aria-label="تغییرات" className="list-disc space-y-1 ps-6">
          {changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <Notice tone="danger">
          <ul aria-label="ایرادها" className="space-y-1">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}
      {warning && <Notice tone="warning">{warning}</Notice>}
      <div className="flex flex-wrap items-end gap-3">
        {withEffectiveDay && (
          <DateField
            mode="single"
            label="اجرا از (اختیاری)"
            hint="خالی یا امروز: از لحظه تأیید. روز بعد: از ابتدای آن روز به وقت تهران."
            today={today}
            min={today}
            value={from}
            onChange={setFrom}
          />
        )}
        <TextField id="reason" name="reason" label="دلیل تغییر" required className="grow" />
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
      <button type="submit" disabled={busy || blocked} className={buttonClass('primary')}>
        ثبت پیشنهاد
      </button>
    </form>
  );
}
