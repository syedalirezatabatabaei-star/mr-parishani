'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  faDigits,
  FILE_KINDS,
  FileDropzone,
  formText,
  Notice,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useId, useState, type SubmitEvent } from 'react';

/**
 * ADR-048: an officer's discount on the origination fee, at most the plan's, with the signed
 * file; no second person (owner). Once per case, and only before the fee's receipt is uploaded.
 */
export function GrantOriginationDiscount({
  applicationId,
  maxDiscountBps,
}: {
  applicationId: string;
  maxDiscountBps: number;
}) {
  const api = useApi();
  const router = useRouter();
  const fileId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const max = maxDiscountBps / 100;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const typed = Number(formText(form, 'percent').trim());
    const file = new FormData(form).get('file');
    if (!Number.isFinite(typed) || typed <= 0 || typed > max) {
      setError(`درصد تخفیف باید بیشتر از صفر و حداکثر ${faDigits(String(max))}٪ باشد.`);
      return;
    }
    if (!(file instanceof File) || file.size === 0) {
      setError('فایل امضاشده تخفیف را انتخاب کنید.');
      return;
    }
    const data = new FormData();
    data.append('discountBps', String(Math.round(typed * 100)));
    data.append('reason', formText(form, 'reason'));
    data.append('file', file);
    setBusy(true);
    setError(null);
    void unwrap(
      api.POST('/api/v1/completion/{applicationId}/origination-discount', {
        params: { path: { applicationId } },
        // multipart/form-data: the browser sets the boundary itself.
        body: data as never,
        bodySerializer: (body: unknown) => body as FormData,
      }),
    )
      .then(() => {
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="ثبت تخفیف مسئول" noValidate>
      <p className="text-[length:var(--text-sm)] text-ink-muted">
        تخفیف مسئول تکمیل یا باشگاه، با امضای خود، حداکثر {faDigits(String(max))}٪ از مبنا؛ بی تأیید
        نفر دوم و در گزارش ماهانه.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={`discount-${applicationId}-percent`}
          label="درصد تخفیف"
          name="percent"
          inputMode="numeric"
          dir="ltr"
          figures
          required
        />
        <TextField id={`discount-${applicationId}-reason`} label="دلیل" name="reason" required />
      </div>
      <FileDropzone
        id={fileId}
        name="file"
        label="فایل امضاشده"
        kinds={[FILE_KINDS.jpg, FILE_KINDS.png, FILE_KINDS.pdf]}
        maxBytes={10 * 1024 * 1024}
        busy={busy}
      />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت تخفیف
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
