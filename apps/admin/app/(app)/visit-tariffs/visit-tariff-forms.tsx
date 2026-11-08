'use client';

import { unwrap } from '@sepehr/api-client';
import { fromJalali, nextJalaliDay, parseRial, type JalaliDate } from '@sepehr/contracts';
import {
  buttonClass,
  DateField,
  defined,
  errorMessage,
  formText,
  MoneyField,
  Notice,
  SelectField,
  TextField,
  useApi,
  type SelectOption,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

function useSubmit() {
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

/**
 * A doctor's visit price, proposed by one person (owner 1405/07/29, answer i). From the
 * second person's approval, or from the start of a later day in Tehran.
 */
export function ProposeVisitTariff({
  workplaces,
  today,
}: {
  workplaces: readonly SelectOption[];
  today: JalaliDate;
}) {
  const api = useApi();
  const { error, setError, busy, run } = useSubmit();
  const [kind, setKind] = useState<'range' | 'free'>('range');
  const [from, setFrom] = useState<JalaliDate | null>(null);
  const [done, setDone] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const min = parseRial(formText(form, 'min'));
    const max = parseRial(formText(form, 'max'));
    if (kind === 'range' && (min === null || max === null || min <= 0n || max < min)) {
      setError('کمینه و بیشینه را به ریال وارد کنید؛ کمینه بیش از صفر و بیشینه دست‌کم برابر آن.');
      return;
    }
    setDone(false);
    void run(() =>
      unwrap(
        api.POST('/api/v1/catalog/visit-tariff-proposals', {
          body: {
            workplaceId: formText(form, 'workplace'),
            pricing:
              kind === 'free'
                ? { kind: 'free' }
                : { kind: 'range', minRial: String(min), maxRial: String(max) },
            ...defined({ effectiveAt: from ? fromJalali(from).toISOString() : undefined }),
            reason: formText(form, 'reason'),
          },
        }),
      ),
    ).then((ok) => {
      if (ok) {
        form.reset();
        setFrom(null);
        setDone(true);
      }
    });
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-label="پیشنهاد تعرفه ویزیت"
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="visit-workplace"
          name="workplace"
          label="پزشک و محل کار"
          emptyLabel="انتخاب پزشک"
          options={workplaces}
        />
        <SelectField
          id="visit-kind"
          name="kind"
          label="نوع قیمت"
          defaultValue="range"
          onChange={(v) => {
            setKind(v === 'free' ? 'free' : 'range');
          }}
          options={[
            { value: 'range', label: 'بازه قیمت' },
            { value: 'free', label: 'ویزیت رایگان' },
          ]}
        />
        {kind === 'range' && (
          <>
            <MoneyField id="visit-min" name="min" label="کمینه" required />
            <MoneyField id="visit-max" name="max" label="بیشینه" required />
          </>
        )}
        <DateField
          mode="single"
          label="اجرا از (اختیاری؛ بی آن، از لحظه تأیید)"
          today={today}
          min={nextJalaliDay(today)}
          value={from}
          onChange={setFrom}
        />
        <TextField id="visit-reason" name="reason" label="دلیل" required />
      </div>
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        پیشنهاد (با تأیید نفر دوم)
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">پیشنهاد ثبت شد. نفر دوم باید آن را تأیید کند.</Notice>}
    </form>
  );
}

/** The second person's decision, with a reason; never the proposer's own (the API says so too). */
export function DecideVisitTariff({ id, mine }: { id: string; mine: boolean }) {
  const api = useApi();
  const { error, setError, busy, run } = useSubmit();
  if (mine) return <span className="text-ink-muted">پیشنهاد شما؛ نفر دوم تصمیم می‌گیرد.</span>;
  const decide = (decision: 'approve' | 'reject', form: HTMLFormElement | null) => {
    const reason = form ? formText(form, 'reason').trim() : '';
    if (reason.length < 3) {
      setError('دلیل تصمیم را بنویسید.');
      return;
    }
    const params = { params: { path: { id } }, body: { reason } };
    void run(() =>
      unwrap(
        decision === 'approve'
          ? api.POST('/api/v1/catalog/visit-tariff-proposals/{id}/approve', params)
          : api.POST('/api/v1/catalog/visit-tariff-proposals/{id}/reject', params),
      ),
    );
  };
  return (
    <form
      className="space-y-2"
      aria-label="تصمیم درباره تعرفه ویزیت"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <TextField id={`visit-decide-${id}`} name="reason" label="دلیل تصمیم" required />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={buttonClass('primary')}
          onClick={(e) => {
            decide('approve', e.currentTarget.form);
          }}
        >
          تأیید تعرفه
        </button>
        <button
          type="button"
          disabled={busy}
          className={buttonClass('secondary')}
          onClick={(e) => {
            decide('reject', e.currentTarget.form);
          }}
        >
          رد
        </button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
