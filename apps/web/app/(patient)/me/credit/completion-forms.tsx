'use client';

import { unwrap } from '@sepehr/api-client';
import { parseRial, type CompletionReceiptKind, type JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  DELIVERY_METHOD,
  errorMessage,
  FILE_KINDS,
  FileDropzone,
  formText,
  MoneyField,
  Notice,
  RECEIPT_KIND,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

const METHODS = ['courier', 'post', 'in_person'] as const;

/** The owner says how the papers were sent (doc 12 §3): courier, post or in person. */
export function DeclareSent({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const method = formText(e.currentTarget, 'method') as (typeof METHODS)[number];
    const trackingCode = formText(e.currentTarget, 'trackingCode').trim();
    void run(() =>
      unwrap(
        api.POST('/api/v1/me/deliveries/{id}/sent', {
          params: { path: { id } },
          body: { method, ...(trackingCode ? { trackingCode } : {}) },
        }),
      ),
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" noValidate>
      <SelectField
        id={`method-${id}`}
        name="method"
        label="روش ارسال"
        defaultValue="courier"
        options={METHODS.map((m) => ({ value: m, label: DELIVERY_METHOD[m] }))}
      />
      <TextField
        id={`tracking-${id}`}
        name="trackingCode"
        label="کد رهگیری (اختیاری)"
        dir="ltr"
        figures
      />
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        اعلام ارسال مدارک
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/**
 * A bank receipt for what completion owes (doc 12 §4; task 4-3): the exact amount (finance
 * accepts nothing else), the Jalali day it was paid, the bank's tracking number and the
 * image or PDF of it. The API checks the file's real type and scans it.
 */
export function ReceiptUpload({
  applicationId,
  kind,
  expectedRial,
  today,
}: {
  applicationId: string;
  kind: CompletionReceiptKind;
  expectedRial: string;
  today: JalaliDate;
}) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  const [paidOn, setPaidOn] = useState<JalaliDate | null>(null);
  const [hasFile, setHasFile] = useState(false);
  const title = RECEIPT_KIND[kind];
  const key = `receipt-${kind}`;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const file = new FormData(form).get('file');
    // Rials as printed on the bank receipt: only the exact amount is approved (owner, 4-3).
    const typed = parseRial(formText(form, 'amount'));
    const amountRial = typed !== null && typed > 0n ? typed.toString() : null;
    const reference = formText(form, 'reference').trim();
    if (!amountRial) {
      setError('مبلغ را به ریال و بدون اعشار، همان‌طور که روی فیش آمده است، وارد کنید.');
      return;
    }
    if (!paidOn) {
      setError('روز پرداخت را انتخاب کنید.');
      return;
    }
    if (!(file instanceof File) || file.size === 0) {
      setError('تصویر یا PDF فیش را انتخاب کنید.');
      return;
    }
    const day = apiDay(paidOn);
    void run(() =>
      unwrap(
        api.POST('/api/v1/me/completion/{applicationId}/receipts', {
          params: { path: { applicationId } },
          body: { kind, amountRial, paidOn: day, reference },
          bodySerializer: (body) => {
            const data = new FormData();
            data.append('kind', body.kind);
            data.append('amountRial', body.amountRial);
            data.append('paidOn', body.paidOn);
            data.append('reference', body.reference);
            data.append('file', file, file.name);
            return data;
          },
        }),
      ),
    );
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-border p-3"
      aria-label={`فیش ${title}`}
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <MoneyField
          id={`${key}-amount`}
          name="amount"
          label={`مبلغ ${title}، مطابق فیش`}
          defaultValue={expectedRial}
          hint="فقط مبلغ دقیق پذیرفته می‌شود."
          required
        />
        <DateField
          mode="single"
          label={`روز پرداخت ${title}`}
          today={today}
          max={today}
          value={paidOn}
          onChange={setPaidOn}
        />
        <TextField
          id={`${key}-reference`}
          name="reference"
          label="شماره پیگیری بانک"
          dir="ltr"
          figures
          required
        />
        <div className="sm:col-span-2">
          <FileDropzone
            id={`${key}-file`}
            name="file"
            label={`فایل فیش ${title}`}
            kinds={[FILE_KINDS.jpg, FILE_KINDS.png, FILE_KINDS.pdf]}
            maxBytes={10 * 1024 * 1024}
            required
            busy={busy}
            onFileChange={(f) => {
              setHasFile(f !== null);
            }}
          />
        </div>
      </div>
      <button type="submit" disabled={busy || !hasFile} className={buttonClass('primary')}>
        ارسال فیش {title}
      </button>
      {!hasFile && (
        <p className="text-[length:var(--text-xs)] text-ink-subtle">
          برای ارسال، فایل فیش را انتخاب کنید.
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
