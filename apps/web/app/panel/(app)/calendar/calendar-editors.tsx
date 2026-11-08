'use client';

import { unwrap } from '@sepehr/api-client';
import {
  toJalali,
  toJalaliDateTime,
  WEEKDAYS,
  type CalendarViewBody,
  type JalaliDate,
  type Weekday,
} from '@sepehr/contracts';
import {
  buttonClass,
  Calendar,
  DateField,
  dayKey,
  errorMessage,
  faDigits,
  formText,
  inputClass,
  Notice,
  SelectField,
  showDay,
  StatusBadge,
  TextField,
  useApi,
  WEEKDAY_NAMES,
  type Capacity,
  type DaySlot,
  type HolidayMark,
  type SelectOption,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

type Range = CalendarViewBody['schedule'][number];
type Exception = CalendarViewBody['exceptions'][number];

const wallTime = (iso: string) => {
  const t = toJalaliDateTime(new Date(iso));
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
};

/** A box with a heading for one part of the calendar page. */
function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={id} className="text-[length:var(--text-lg)] font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A request to the API, its error said under the form, and the page read again after. */
function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await work();
      setDone(success);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, submit };
}

/** The free times in month, week and day views (doc 08 §13: a center has all three). */
export function SlotsCalendar({
  today,
  slots,
  holidays,
}: {
  today: JalaliDate;
  slots: readonly { startsAt: string; serviceCodes: readonly string[] }[];
  holidays: readonly HolidayMark[];
}) {
  const [day, setDay] = useState<JalaliDate | null>(today);
  const { byDay, capacity } = useMemo(() => {
    const days: Record<string, DaySlot[]> = {};
    for (const s of slots) {
      (days[dayKey(toJalali(new Date(s.startsAt)))] ??= []).push({
        startsAt: s.startsAt,
        time: wallTime(s.startsAt),
        available: true,
      });
    }
    const full: Record<string, Capacity> = {};
    for (const [key, list] of Object.entries(days))
      full[key] = list.length >= 4 ? 'free' : 'limited';
    return { byDay: days, capacity: full };
  }, [slots]);
  return (
    <Calendar
      mode="single"
      label="زمان‌های آزاد محل کار"
      value={day}
      onChange={setDay}
      today={today}
      holidays={holidays}
      capacity={capacity}
      slots={byDay}
      views={['month', 'week', 'day']}
    />
  );
}

/** Whether requests wait for the center (manual) or are confirmed at once (automatic). */
export function ApprovalModeForm({
  workplaceId,
  mode,
  source,
  canEdit,
}: {
  workplaceId: string;
  mode: 'auto' | 'manual';
  source: 'workplace' | 'default';
  canEdit: boolean;
}) {
  const api = useApi();
  const { busy, error, done, submit } = useSubmit();
  const [chosen, setChosen] = useState(mode);
  const [reason, setReason] = useState('');
  return (
    <Part id="approval-mode" title="تأیید نوبت‌ها">
      <p className="text-[length:var(--text-sm)] text-ink-muted">
        اکنون: {mode === 'manual' ? 'دستی، با تأیید مرکز' : 'خودکار، بی‌تأیید مرکز'}
        {source === 'default' ? ' (پیش‌فرض سامانه)' : ''}. تغییر فقط روی درخواست‌های تازه اثر دارد.
      </p>
      {canEdit && (
        <form
          className="flex flex-wrap items-end gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              () =>
                unwrap(
                  api.PUT('/api/v1/booking/workplaces/{id}/approval-mode', {
                    params: { path: { id: workplaceId } },
                    body: { mode: chosen, reason },
                  }),
                ),
              'حالت تأیید ذخیره شد.',
            );
          }}
        >
          <fieldset className="flex gap-4">
            <legend className="sr-only">حالت تأیید</legend>
            {(['manual', 'auto'] as const).map((m) => (
              <label key={m} className="flex min-h-10 items-center gap-2">
                <input
                  type="radio"
                  name="mode"
                  value={m}
                  checked={chosen === m}
                  onChange={() => {
                    setChosen(m);
                  }}
                  className="size-5 accent-[var(--color-accent)]"
                />
                {m === 'manual' ? 'دستی' : 'خودکار'}
              </label>
            ))}
          </fieldset>
          <label className="block min-w-56 grow space-y-1">
            <span className="block text-[length:var(--text-sm)] font-medium">دلیل تغییر</span>
            <input
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
              className={inputClass}
            />
          </label>
          <button
            type="submit"
            disabled={busy || chosen === mode}
            className={buttonClass('primary')}
          >
            ذخیره
          </button>
        </form>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </Part>
  );
}

const SLOT_CHOICES = [10, 15, 20, 30, 45, 60] as const;

interface EditableRange {
  readonly key: string;
  weekday: Weekday;
  start: string;
  end: string;
  slotMinutes: number;
  serviceCodes: string[];
}

const toEditable = (r: Range, i: number): EditableRange => ({
  key: `${String(i)}-${r.weekday}-${r.start}`,
  weekday: r.weekday,
  start: faDigits(r.start),
  end: faDigits(r.end),
  slotMinutes: r.slotMinutes,
  serviceCodes: [...r.serviceCodes],
});

/** The weekly hours, replaced as a whole with a reason (rule 9). */
export function ScheduleEditor({
  workplaceId,
  schedule,
  services,
  canEdit,
}: {
  workplaceId: string;
  schedule: readonly Range[];
  services: readonly SelectOption[];
  canEdit: boolean;
}) {
  const api = useApi();
  const { busy, error, done, submit } = useSubmit();
  const [rows, setRows] = useState<EditableRange[]>(schedule.map(toEditable));
  const update = (key: string, change: Partial<EditableRange>) => {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...change } : r)));
  };
  const serviceName = (code: string) => services.find((s) => s.value === code)?.label ?? code;

  if (!canEdit) {
    return (
      <Part id="schedule" title="ساعت‌های کاری هفته">
        {schedule.length === 0 ? (
          <p className="text-ink-muted">ساعت کاری ثبت نشده است.</p>
        ) : (
          <ul className="space-y-1 text-[length:var(--text-sm)]">
            {schedule.map((r, i) => (
              <li key={`${String(i)}-${r.weekday}`} className="figures">
                {WEEKDAY_NAMES[r.weekday]}: {faDigits(r.start)} تا {faDigits(r.end)}، نوبت‌های{' '}
                {faDigits(r.slotMinutes)} دقیقه‌ای ({r.serviceCodes.map(serviceName).join('، ')})
              </li>
            ))}
          </ul>
        )}
      </Part>
    );
  }

  return (
    <Part id="schedule" title="ساعت‌های کاری هفته">
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          void submit(
            () =>
              unwrap(
                api.PUT('/api/v1/booking/workplaces/{id}/schedule', {
                  params: { path: { id: workplaceId } },
                  body: {
                    ranges: rows.map(({ weekday, start, end, slotMinutes, serviceCodes }) => ({
                      weekday,
                      start,
                      end,
                      slotMinutes,
                      serviceCodes,
                    })),
                    reason,
                  },
                }),
              ),
            'ساعت‌های کاری ذخیره شد.',
          );
        }}
      >
        {rows.length === 0 && <p className="text-ink-muted">ساعت کاری ثبت نشده است.</p>}
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={r.key} className="flex flex-wrap items-end gap-2 rounded-md bg-sunken p-2">
              <label className="space-y-1">
                <span className="block text-[length:var(--text-xs)]">روز</span>
                <select
                  aria-label={`روز بازه ${faDigits(i + 1)}`}
                  value={r.weekday}
                  onChange={(e) => {
                    update(r.key, { weekday: e.target.value as Weekday });
                  }}
                  className={inputClass}
                >
                  {WEEKDAYS.map((w) => (
                    <option key={w} value={w}>
                      {WEEKDAY_NAMES[w]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block text-[length:var(--text-xs)]">از</span>
                <input
                  aria-label={`شروع بازه ${faDigits(i + 1)}`}
                  value={r.start}
                  onChange={(e) => {
                    update(r.key, { start: e.target.value });
                  }}
                  dir="ltr"
                  inputMode="numeric"
                  placeholder="۰۹:۰۰"
                  className={`${inputClass} figures w-24`}
                />
              </label>
              <label className="space-y-1">
                <span className="block text-[length:var(--text-xs)]">تا</span>
                <input
                  aria-label={`پایان بازه ${faDigits(i + 1)}`}
                  value={r.end}
                  onChange={(e) => {
                    update(r.key, { end: e.target.value });
                  }}
                  dir="ltr"
                  inputMode="numeric"
                  placeholder="۱۳:۰۰"
                  className={`${inputClass} figures w-24`}
                />
              </label>
              <label className="space-y-1">
                <span className="block text-[length:var(--text-xs)]">مدت هر نوبت</span>
                <select
                  aria-label={`مدت نوبت بازه ${faDigits(i + 1)}`}
                  value={r.slotMinutes}
                  onChange={(e) => {
                    update(r.key, { slotMinutes: Number(e.target.value) });
                  }}
                  className={inputClass}
                >
                  {SLOT_CHOICES.map((m) => (
                    <option key={m} value={m}>
                      {faDigits(m)} دقیقه
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block text-[length:var(--text-xs)]">خدمت</span>
                <select
                  aria-label={`خدمت بازه ${faDigits(i + 1)}`}
                  value={r.serviceCodes[0] ?? 'visit'}
                  onChange={(e) => {
                    update(r.key, { serviceCodes: [e.target.value] });
                  }}
                  className={inputClass}
                >
                  {services.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={buttonClass('quiet')}
                onClick={() => {
                  setRows((list) => list.filter((x) => x.key !== r.key));
                }}
              >
                حذف بازه
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setRows((list) => [
              ...list,
              {
                key: `new-${String(Date.now())}`,
                weekday: 'saturday',
                start: '۰۹:۰۰',
                end: '۱۳:۰۰',
                slotMinutes: 30,
                serviceCodes: ['visit'],
              },
            ]);
          }}
        >
          افزودن بازه
        </button>
        <TextField id="schedule-reason" name="reason" label="دلیل تغییر" required />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ذخیره ساعت‌های کاری
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </Part>
  );
}

const EXCEPTION_KIND: Readonly<
  Record<Exception['kind'], { label: string; tone: 'danger' | 'success' | 'info' }>
> = {
  closed: { label: 'تعطیل', tone: 'danger' },
  extra: { label: 'ساعت اضافه', tone: 'success' },
  open_holiday: { label: 'باز در روز تعطیل', tone: 'info' },
};

/** Single days: closed (all or part), extra hours, or open on a holiday. */
export function ExceptionEditor({
  workplaceId,
  exceptions,
  services,
  today,
  canEdit,
}: {
  workplaceId: string;
  exceptions: readonly Exception[];
  services: readonly SelectOption[];
  today: JalaliDate;
  canEdit: boolean;
}) {
  const api = useApi();
  const { busy, error, done, submit } = useSubmit();
  const [kind, setKind] = useState<Exception['kind']>('closed');
  const [day, setDay] = useState<JalaliDate | null>(null);

  return (
    <Part id="exceptions" title="استثناهای روزها">
      {exceptions.length === 0 ? (
        <p className="text-ink-muted">از امروز به بعد استثنایی ثبت نشده است.</p>
      ) : (
        <ul className="space-y-2">
          {exceptions.map((x) => (
            <li
              key={x.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-sunken p-2"
            >
              <span className="space-x-2">
                <StatusBadge tone={EXCEPTION_KIND[x.kind].tone}>
                  {EXCEPTION_KIND[x.kind].label}
                </StatusBadge>{' '}
                <span className="figures">{showDay(x.on, 'long')}</span>
                {x.start && x.end && (
                  <span className="figures">
                    {' '}
                    {faDigits(x.start)} تا {faDigits(x.end)}
                  </span>
                )}
                <span className="text-[length:var(--text-sm)] text-ink-muted"> — {x.reason}</span>
              </span>
              {canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('quiet')}
                  onClick={() => {
                    void submit(
                      () =>
                        unwrap(
                          api.POST('/api/v1/booking/exceptions/{id}/remove', {
                            params: { path: { id: x.id } },
                            body: { reason: 'برداشتن استثنا از پنل مرکز' },
                          }),
                        ),
                      'استثنا برداشته شد.',
                    );
                  }}
                >
                  برداشتن
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="space-y-3 border-t border-border pt-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const text = (name: string) => {
              const v = form.get(name);
              return typeof v === 'string' ? v : '';
            };
            if (!day) return;
            const reason = text('reason');
            const body =
              kind === 'extra'
                ? {
                    kind,
                    on: day,
                    start: text('start'),
                    end: text('end'),
                    slotMinutes: Number(text('slotMinutes')),
                    serviceCodes: [text('service')],
                    reason,
                  }
                : kind === 'closed'
                  ? {
                      kind,
                      on: day,
                      ...(text('start') && text('end')
                        ? { start: text('start'), end: text('end') }
                        : {}),
                      reason,
                    }
                  : { kind, on: day, reason };
            void submit(
              () =>
                unwrap(
                  api.POST('/api/v1/booking/workplaces/{id}/exceptions', {
                    params: { path: { id: workplaceId } },
                    body,
                  }),
                ),
              'استثنا ثبت شد.',
            );
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              id="exception-kind"
              name="kind"
              label="نوع"
              defaultValue={kind}
              onChange={(v) => {
                setKind(v as Exception['kind']);
              }}
              options={(Object.keys(EXCEPTION_KIND) as Exception['kind'][]).map((k) => ({
                value: k,
                label: EXCEPTION_KIND[k].label,
              }))}
            />
            <div className="min-w-56">
              <DateField
                mode="single"
                label="روز"
                value={day}
                onChange={setDay}
                today={today}
                min={today}
                hint=""
              />
            </div>
          </div>
          {kind !== 'open_holiday' && (
            <div className="flex flex-wrap items-end gap-3">
              <TextField
                id="exception-start"
                name="start"
                label={kind === 'closed' ? 'از (خالی: کل روز)' : 'از'}
                dir="ltr"
                figures
                placeholder="۰۹:۰۰"
              />
              <TextField
                id="exception-end"
                name="end"
                label="تا"
                dir="ltr"
                figures
                placeholder="۱۳:۰۰"
              />
              {kind === 'extra' && (
                <>
                  <SelectField
                    id="exception-slot"
                    name="slotMinutes"
                    label="مدت هر نوبت"
                    defaultValue="30"
                    options={SLOT_CHOICES.map((m) => ({
                      value: String(m),
                      label: `${faDigits(m)} دقیقه`,
                    }))}
                  />
                  <SelectField
                    id="exception-service"
                    name="service"
                    label="خدمت"
                    defaultValue="visit"
                    options={services}
                  />
                </>
              )}
            </div>
          )}
          <TextField id="exception-reason" name="reason" label="دلیل" required />
          <button type="submit" disabled={busy || !day} className={buttonClass('primary')}>
            ثبت استثنا
          </button>
        </form>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </Part>
  );
}
