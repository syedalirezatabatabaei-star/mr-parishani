'use client';

import { unwrap } from '@sepehr/api-client';
import { normalizeDigits, parseRial, type JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  DateField,
  DELIVERY_METHOD,
  errorMessage,
  formText,
  MoneyField,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode, type SubmitEvent } from 'react';

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

/** Rials typed in any digits and separators (owner, 1405/07/11); null unless positive. */
function rialsOf(typed: string): string | null {
  const rial = parseRial(typed);
  return rial !== null && rial > 0n ? rial.toString() : null;
}

function ActionError({ error }: { error: string | null }) {
  return error ? <Notice tone="danger">{error}</Notice> : null;
}

/** One button that asks the API for one thing; the service decides whether it may. */
function ActionButton({
  label,
  action,
  variant = 'secondary',
}: {
  label: string;
  action: (api: ReturnType<typeof useApi>) => Promise<unknown>;
  variant?: 'primary' | 'secondary' | 'quiet';
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        className={buttonClass(variant)}
        onClick={() => void run(() => action(api))}
      >
        {label}
      </button>
      <ActionError error={error} />
    </span>
  );
}

/** A signed link opened in a new tab; every view is logged by the API (doc 04 §7). */
function LinkButton({
  label,
  fetchLink,
}: {
  label: string;
  fetchLink: (api: ReturnType<typeof useApi>) => Promise<{ url: string }>;
}) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('quiet')}
        onClick={() => {
          setBusy(true);
          setError(null);
          fetchLink(api)
            .then((link) => window.open(link.url, '_blank', 'noopener'))
            .catch((err: unknown) => {
              setError(errorMessage(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        {label}
      </button>
      <ActionError error={error} />
    </span>
  );
}

// --- contract ------------------------------------------------------------------------

export function GenerateContract({ applicationId }: { applicationId: string }) {
  return (
    <ActionButton
      label="ساخت قرارداد"
      variant="primary"
      action={(api) =>
        unwrap(api.POST('/api/v1/contracts', { body: { creditApplicationId: applicationId } }))
      }
    />
  );
}

export function ViewContract({ id }: { id: string }) {
  return (
    <LinkButton
      label="مشاهده PDF قرارداد"
      fetchLink={(api) =>
        unwrap(api.GET('/api/v1/contracts/{id}/link', { params: { path: { id } } }))
      }
    />
  );
}

// --- physical delivery ---------------------------------------------------------------

type ItemKind = 'signed_contract' | 'cheque' | 'promissory_note' | 'other';

/**
 * What the office expects to receive (doc 12 §3): the signed contract, a number of
 * cheques and notes, and any other paper by name.
 */
export function CreateDelivery({
  applicationId,
  promissoryNotes,
}: {
  applicationId: string;
  /** Owner 1405/07/27: promissory notes are not taken while their flag is off. */
  promissoryNotes: boolean;
}) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const count = (name: string) => Number(normalizeDigits(formText(form, name)) || '0');
    const cheques = count('cheques');
    const notes = promissoryNotes ? count('notes') : 0;
    const others = formText(form, 'others')
      .split(/[\n،,]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    const items: { kind: ItemKind; label: string }[] = [];
    if (new FormData(form).get('contract') === 'on') {
      items.push({ kind: 'signed_contract', label: 'قرارداد امضاشده' });
    }
    for (let i = 1; i <= cheques; i++) items.push({ kind: 'cheque', label: `چک ${String(i)}` });
    for (let i = 1; i <= notes; i++) {
      items.push({ kind: 'promissory_note', label: `سفته ${String(i)}` });
    }
    for (const label of others) items.push({ kind: 'other', label });
    if (items.length === 0) {
      setError('دست‌کم یک قلم لازم است.');
      return;
    }
    void run(() =>
      unwrap(
        api.POST('/api/v1/deliveries', { body: { creditApplicationId: applicationId, items } }),
      ),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate aria-label="فهرست مدارک فیزیکی">
      <label className="flex items-center gap-2">
        <input type="checkbox" name="contract" defaultChecked />
        قرارداد امضاشده
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          id="cheques"
          name="cheques"
          label="تعداد چک"
          inputMode="numeric"
          dir="ltr"
          figures
          defaultValue="1"
        />
        {promissoryNotes && (
          <TextField
            id="notes"
            name="notes"
            label="تعداد سفته"
            inputMode="numeric"
            dir="ltr"
            figures
            defaultValue="0"
          />
        )}
        <TextField id="others" name="others" label="سایر مدارک (با ویرگول)" />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت فهرست مدارک فیزیکی
      </button>
      <ActionError error={error} />
    </form>
  );
}

const METHODS = ['courier', 'post', 'in_person'] as const;

/** The papers reached the office: how, and the courier's or post's code. */
export function ReceiveDelivery({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const method = formText(e.currentTarget, 'method') as (typeof METHODS)[number];
    const trackingCode = formText(e.currentTarget, 'trackingCode').trim();
    void run(() =>
      unwrap(
        api.POST('/api/v1/deliveries/{id}/receive', {
          params: { path: { id } },
          body: { method, ...(trackingCode ? { trackingCode } : {}) },
        }),
      ),
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" noValidate>
      <SelectField
        id={`receive-method-${id}`}
        name="method"
        label="روش رسیدن"
        defaultValue="in_person"
        options={METHODS.map((m) => ({ value: m, label: DELIVERY_METHOD[m] }))}
      />
      <TextField
        id={`receive-tracking-${id}`}
        name="trackingCode"
        label="کد رهگیری (اختیاری)"
        dir="ltr"
        figures
      />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت دریافت مدارک
      </button>
      <ActionError error={error} />
    </form>
  );
}

export function MarkItem({ deliveryId, itemId }: { deliveryId: string; itemId: string }) {
  const mark = (status: 'received' | 'missing') => (api: ReturnType<typeof useApi>) =>
    unwrap(
      api.POST('/api/v1/deliveries/{id}/items/{itemId}', {
        params: { path: { id: deliveryId, itemId } },
        body: { status },
      }),
    );
  return (
    <span className="flex flex-wrap gap-2">
      <ActionButton label="رسید" action={mark('received')} />
      <ActionButton label="نرسید" variant="quiet" action={mark('missing')} />
    </span>
  );
}

/**
 * A cheque or note on its item (doc 12 §3; task 4-2): who issued it, its amount, due day,
 * bank, and its number, which the API keeps encrypted and shows by its last four only.
 */
export function RegisterInstrument({
  deliveryId,
  itemId,
  kind,
  guarantors,
  today,
}: {
  deliveryId: string;
  itemId: string;
  kind: 'cheque' | 'promissory_note';
  guarantors: readonly { id: string; title: string }[];
  today: JalaliDate;
}) {
  const api = useApi();
  const { error, setError, busy, run } = useAction();
  const [due, setDue] = useState<JalaliDate | null>(null);
  const key = `instrument-${itemId}`;
  const what = kind === 'cheque' ? 'چک' : 'سفته';
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const amountRial = rialsOf(formText(form, 'amount'));
    if (!amountRial) {
      setError('مبلغ را به ریال و بدون اعشار وارد کنید.');
      return;
    }
    const issuerValue = formText(form, 'issuer');
    const issuer =
      issuerValue === 'borrower'
        ? ({ role: 'borrower' } as const)
        : ({ role: 'guarantor', guarantorId: issuerValue } as const);
    const bankName = formText(form, 'bankName').trim();
    const notes = formText(form, 'notes').trim();
    void run(() =>
      unwrap(
        api.POST('/api/v1/deliveries/{id}/instruments', {
          params: { path: { id: deliveryId } },
          body: {
            itemId,
            kind,
            issuer,
            amountRial,
            number: formText(form, 'number'),
            ...(due ? { dueOn: apiDay(due) } : {}),
            ...(bankName ? { bankName } : {}),
            ...(notes ? { notes } : {}),
          },
        }),
      ),
    );
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-border p-3"
      aria-label={`ثبت ${what}`}
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id={`${key}-issuer`}
          name="issuer"
          label="صادرکننده"
          defaultValue="borrower"
          options={[
            { value: 'borrower', label: 'وام‌گیرنده' },
            ...guarantors.map((g) => ({ value: g.id, label: g.title })),
          ]}
        />
        <MoneyField id={`${key}-amount`} name="amount" label={`مبلغ ${what}`} required />
        <TextField
          id={`${key}-number`}
          name="number"
          label={kind === 'cheque' ? 'شماره صیادی' : 'شماره سریال سفته'}
          dir="ltr"
          figures
          autoComplete="off"
          required
        />
        <DateField
          mode="single"
          label={`سررسید ${what} (اختیاری)`}
          today={today}
          min={today}
          value={due}
          onChange={setDue}
        />
        <TextField id={`${key}-bank`} name="bankName" label="بانک (اختیاری)" />
        <TextField id={`${key}-notes`} name="notes" label="یادداشت (اختیاری)" />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت {what}
      </button>
      <ActionError error={error} />
    </form>
  );
}

export function ConfirmSayad({ id }: { id: string }) {
  return (
    <ActionButton
      label="تأیید ثبت در سامانه صیاد"
      action={(api) =>
        unwrap(api.POST('/api/v1/instruments/{id}/sayad', { params: { path: { id } } }))
      }
    />
  );
}

export function VerifyInstrument({ id }: { id: string }) {
  return (
    <ActionButton
      label="بررسی‌شده"
      action={(api) =>
        unwrap(api.POST('/api/v1/instruments/{id}/verify', { params: { path: { id } } }))
      }
    />
  );
}

/** The full number, only with its own permission; every view is logged (rule 27). */
export function ShowNumber({ id }: { id: string }) {
  const api = useApi();
  const [number, setNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (number) return <bdi className="figures font-bold">{number}</bdi>;
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setError(null);
          unwrap(api.GET('/api/v1/instruments/{id}/number', { params: { path: { id } } }))
            .then((v) => {
              setNumber(v.number);
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            });
        }}
      >
        نمایش شماره کامل
      </button>
      <ActionError error={error} />
    </span>
  );
}

export function CheckDelivery({ id }: { id: string }) {
  return (
    <ActionButton
      label="بررسی تحویل"
      variant="primary"
      action={(api) =>
        unwrap(api.POST('/api/v1/deliveries/{id}/check', { params: { path: { id } } }))
      }
    />
  );
}

function ReasonForm({
  id,
  label,
  field,
  button,
  send,
}: {
  id: string;
  label: string;
  field: string;
  button: string;
  send: (api: ReturnType<typeof useApi>, value: string) => Promise<unknown>;
}): ReactNode {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const value = formText(e.currentTarget, field);
        void run(() => send(api, value));
      }}
    >
      <TextField id={id} name={field} label={label} required />
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        {button}
      </button>
      <ActionError error={error} />
    </form>
  );
}

export function ArchiveDelivery({ id }: { id: string }) {
  return (
    <ReasonForm
      id={`archive-${id}`}
      label="محل بایگانی"
      field="location"
      button="بایگانی"
      send={(api, location) =>
        unwrap(
          api.POST('/api/v1/deliveries/{id}/archive', {
            params: { path: { id } },
            body: { location },
          }),
        )
      }
    />
  );
}

export function ReturnDelivery({ id }: { id: string }) {
  return (
    <ReasonForm
      id={`return-${id}`}
      label="دلیل برگشت"
      field="reason"
      button="برگشت مدارک"
      send={(api, reason) =>
        unwrap(
          api.POST('/api/v1/deliveries/{id}/return', {
            params: { path: { id } },
            body: { reason },
          }),
        )
      }
    />
  );
}

// --- conditions and completion -------------------------------------------------------

/** A condition of a conditional approval, ticked once, with who and when (task 4-3). */
export function CheckCondition({ applicationId, index }: { applicationId: string; index: number }) {
  return (
    <ActionButton
      label="برقرار است"
      action={(api) =>
        unwrap(
          api.POST('/api/v1/credit/applications/{id}/conditions/{index}/check', {
            params: { path: { id: applicationId, index } },
            body: {},
          }),
        )
      }
    />
  );
}

export function ViewReceiptFile({ id }: { id: string }) {
  return (
    <LinkButton
      label="مشاهده فیش"
      fetchLink={(api) =>
        unwrap(api.GET('/api/v1/receipts/{id}/link', { params: { path: { id } } }))
      }
    />
  );
}

/** Recorded by the service only when every condition holds (doc 12 §4). */
export function CompleteApplication({ applicationId }: { applicationId: string }) {
  return (
    <ActionButton
      label="ثبت تکمیل پرونده"
      variant="primary"
      action={(api) =>
        unwrap(
          api.POST('/api/v1/completion/{applicationId}/complete', {
            params: { path: { applicationId } },
          }),
        )
      }
    />
  );
}
