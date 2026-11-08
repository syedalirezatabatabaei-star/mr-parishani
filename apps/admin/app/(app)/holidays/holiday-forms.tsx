'use client';

import { unwrap } from '@sepehr/api-client';
import type { JalaliDate } from '@sepehr/contracts';
import {
  buttonClass,
  CheckboxField,
  DateField,
  errorMessage,
  formText,
  Notice,
  SelectField,
  StatusBadge,
  TextField,
  useApi,
  type SelectOption,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * A new holiday: national, or a city's own (e.g. Isfahan's local holidays). Owner 1405/07/27:
 * asked as a one-day batch, saved only once a second holder approves (ADR-043).
 */
export function HolidayForm({
  today,
  cities,
}: {
  today: JalaliDate;
  cities: readonly SelectOption[];
}) {
  const api = useApi();
  const router = useRouter();
  const [day, setDay] = useState<JalaliDate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <section
      aria-labelledby="new-holiday"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="new-holiday" className="text-[length:var(--text-lg)] font-bold">
        تعطیلی تازه
      </h2>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!day) {
            setError('روز را انتخاب کنید.');
            return;
          }
          const form = e.currentTarget;
          const cityCode = formText(form, 'city');
          setBusy(true);
          setError(null);
          setDone(null);
          void unwrap(
            api.POST('/api/v1/calendar/holidays/batches', {
              body: {
                year: day.year,
                days: [
                  { on: day, title: formText(form, 'title'), ...(cityCode ? { cityCode } : {}) },
                ],
                reason: formText(form, 'reason'),
              },
            }),
          )
            .then(() => {
              setDone('درخواست ثبت شد. نفر دوم باید آن را تأیید کند.');
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
          <div className="min-w-56">
            <DateField
              mode="single"
              label="روز"
              value={day}
              onChange={setDay}
              today={today}
              hint=""
            />
          </div>
          <TextField
            id="holiday-title"
            name="title"
            label="عنوان"
            required
            className="min-w-56 grow"
          />
          <SelectField
            id="holiday-city"
            name="city"
            label="شهر"
            emptyLabel="سراسری"
            options={cities}
          />
        </div>
        <TextField id="holiday-reason" name="reason" label="دلیل" required />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          درخواست ثبت (با تأیید نفر دوم)
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </section>
  );
}

/** One new day the batch may hold, as the page shows it. */
export interface BatchDayOption {
  on: JalaliDate;
  /** Gregorian YYYY-MM-DD: the form's key. */
  key: string;
  label: string;
  title: string;
  estimated: boolean;
}

/**
 * Asking for the year's new holidays to be saved together (owner 1405/07/24, plan 3): a second
 * holder approves, all or none. Lunar days are unticked: estimates, ticked only once the
 * official calendar confirms them.
 */
export function HolidayBatchForm({
  year,
  days,
}: {
  year: number;
  days: readonly BatchDayOption[];
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (days.length === 0) return null;
  return (
    <form
      className="space-y-3"
      noValidate
      aria-label="درخواست ذخیره دسته‌ای"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        const chosen = days.filter((d) => data.get(`batch-${d.key}`) === 'true');
        if (chosen.length === 0) {
          setError('دست‌کم یک روز را انتخاب کنید.');
          return;
        }
        setBusy(true);
        setError(null);
        setDone(null);
        void unwrap(
          api.POST('/api/v1/calendar/holidays/batches', {
            body: {
              year,
              days: chosen.map((d) => ({ on: d.on, title: d.title })),
              reason: formText(form, 'batch-reason'),
            },
          }),
        )
          .then(() => {
            setDone('درخواست ثبت شد. نفر دوم باید آن را تأیید کند.');
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
      <fieldset className="space-y-2">
        <legend className="font-bold">روزهای تازه برای ذخیره</legend>
        {days.map((d) => (
          <CheckboxField
            key={d.key}
            id={`batch-${d.key}`}
            name={`batch-${d.key}`}
            label={`${d.label} · ${d.title}`}
            defaultChecked={!d.estimated}
            {...(d.estimated ? { hint: 'قمری، تخمینی: فقط پس از اعلام رسمی انتخاب کنید.' } : {})}
          />
        ))}
      </fieldset>
      <TextField id="batch-reason" name="batch-reason" label="دلیل درخواست" required />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        درخواست ذخیره (با تأیید نفر دوم)
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </form>
  );
}

/** A second holder approves or rejects a waiting batch; never its asker (the API refuses). */
export function HolidayBatchDecision({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    const path =
      decision === 'approve'
        ? '/api/v1/calendar/holidays/batches/{id}/approve'
        : '/api/v1/calendar/holidays/batches/{id}/reject';
    void unwrap(api.POST(path, { params: { path: { id } } }))
      .then(() => {
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
      });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() => {
          decide('approve');
        }}
      >
        تأیید و ذخیره همه
      </button>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('quiet')}
        onClick={() => {
          decide('reject');
        }}
      >
        رد
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

/**
 * Asking for a holiday to be taken off the calendar (owner 1405/07/29): removed only once a
 * second holder approves.
 */
export function HolidayRemovalRequest({ id, label }: { id: string; label: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (done) return <StatusBadge tone="warning">در انتظار تأیید نفر دوم</StatusBadge>;
  return (
    <details>
      <summary className="cursor-pointer text-accent">درخواست برداشتن</summary>
      <form
        className="mt-2 space-y-2"
        noValidate
        aria-label={`درخواست برداشتن ${label}`}
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          setBusy(true);
          setError(null);
          void unwrap(
            api.POST('/api/v1/calendar/holidays/removals', {
              body: { holidayId: id, reason: formText(form, 'reason') },
            }),
          )
            .then(() => {
              setDone(true);
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
        <TextField id={`removal-reason-${id}`} name="reason" label="دلیل برداشتن" required />
        <button type="submit" disabled={busy} className={buttonClass('quiet')}>
          درخواست برداشتن (با تأیید نفر دوم)
        </button>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </details>
  );
}

/** A second holder approves (the holiday is removed) or rejects a waiting removal. */
export function HolidayRemovalDecision({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    const path =
      decision === 'approve'
        ? '/api/v1/calendar/holidays/removals/{id}/approve'
        : '/api/v1/calendar/holidays/removals/{id}/reject';
    void unwrap(api.POST(path, { params: { path: { id } } }))
      .then(() => {
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
      });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() => {
          decide('approve');
        }}
      >
        تأیید و برداشتن
      </button>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('quiet')}
        onClick={() => {
          decide('reject');
        }}
      >
        رد
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
