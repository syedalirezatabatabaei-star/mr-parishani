'use client';

import { unwrap } from '@sepehr/api-client';
import { parseRial, type JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  errorMessage,
  FILE_KINDS,
  FileDropzone,
  formText,
  MoneyField,
  Notice,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

/**
 * The borrower sends a slip of an installment payment (task 6-2's API; doc 15 §2): the amount
 * as on the slip, the Jalali day, the bank's tracking number, the payer and the file. Finance
 * approves it; it is allocated to the oldest installment first.
 */
export function RepaymentReceiptForm({
  scheduleId,
  today,
}: {
  scheduleId: string;
  today: JalaliDate;
}) {
  const api = useApi();
  const router = useRouter();
  const [paidOn, setPaidOn] = useState<JalaliDate | null>(null);
  const [hasFile, setHasFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = `slip-${scheduleId}`;

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const file = new FormData(form).get('file');
    const typed = parseRial(formText(form, 'amount'));
    const amountRial = typed !== null && typed > 0n ? typed.toString() : null;
    const bankRef = formText(form, 'bankRef').trim();
    const payerName = formText(form, 'payerName').trim();
    setSent(null);
    if (!amountRial) {
      setError('مبلغ را همان‌طور که روی فیش آمده است وارد کنید.');
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
    setBusy(true);
    setError(null);
    try {
      const made = await unwrap(
        api.POST('/api/v1/me/repayment/receipts', {
          body: { scheduleId, amountRial, paidOn: apiDay(paidOn), bankRef, payerName },
          bodySerializer: (body) => {
            const data = new FormData();
            data.append('scheduleId', body.scheduleId);
            data.append('amountRial', body.amountRial);
            data.append('paidOn', body.paidOn);
            data.append('bankRef', body.bankRef);
            data.append('payerName', body.payerName);
            data.append('file', file, file.name);
            return data;
          },
        }),
      );
      form.reset();
      setPaidOn(null);
      setSent(
        made.suspectedDuplicate
          ? 'فیش ثبت شد. فیشی مشابه آن پیش‌تر رسیده است؛ مالی هر دو را بررسی می‌کند.'
          : 'فیش ثبت شد و پس از تأیید مالی به قدیمی‌ترین قسط شما می‌نشیند.',
      );
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="ارسال فیش قسط"
      noValidate
    >
      <h3 className="font-bold">ارسال فیش قسط</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <MoneyField id={`${key}-amount`} name="amount" label="مبلغ واریزی، مطابق فیش" required />
        <DateField
          mode="single"
          label="روز واریز"
          today={today}
          max={today}
          value={paidOn}
          onChange={setPaidOn}
        />
        <TextField
          id={`${key}-ref`}
          name="bankRef"
          label="شماره پیگیری بانک"
          dir="ltr"
          figures
          required
        />
        <TextField id={`${key}-payer`} name="payerName" label="نام واریزکننده" required />
        <div className="sm:col-span-2">
          <FileDropzone
            id={`${key}-file`}
            name="file"
            label="فایل فیش"
            kinds={[FILE_KINDS.jpg, FILE_KINDS.png, FILE_KINDS.pdf]}
            maxBytes={5 * 1024 * 1024}
            required
            busy={busy}
            onFileChange={(f) => {
              setHasFile(f !== null);
            }}
          />
        </div>
      </div>
      <button type="submit" disabled={busy || !hasFile} className={buttonClass('primary')}>
        ارسال فیش
      </button>
      {!hasFile && (
        <p className="text-[length:var(--text-xs)] text-ink-subtle">
          برای ارسال، فایل فیش را انتخاب کنید.
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {sent && <Notice tone="success">{sent}</Notice>}
    </form>
  );
}
