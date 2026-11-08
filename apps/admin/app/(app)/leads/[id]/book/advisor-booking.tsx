'use client';

import { unwrap } from '@sepehr/api-client';
import {
  addJalaliDays,
  toJalali,
  toJalaliDateTime,
  type AppointmentViewBody,
  type JalaliDate,
  type SearchResponse,
} from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  Calendar,
  dayKey,
  errorMessage,
  faDigits,
  formText,
  Notice,
  showInstant,
  TextField,
  useApi,
  type Capacity,
  type DaySlot,
  type HolidayMark,
} from '@sepehr/ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';

type Result = SearchResponse['results'][number];

interface FreeSlot {
  readonly startsAt: string;
  readonly serviceCodes: readonly string[];
}

interface Chosen {
  readonly result: Result;
  readonly slots: readonly FreeSlot[];
  readonly holidays: readonly HolidayMark[];
}

/** How far ahead the calendar asks for free times: the API cuts it at the booking horizon. */
const DAYS_AHEAD = 61;
/** A day with this many free times or more is «free»; fewer is «limited» (a display rule). */
const PLENTY = 4;

const wallTime = (iso: string) => {
  const t = toJalaliDateTime(new Date(iso));
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
};

/**
 * An advisor books for the patient of one of their cases (doc 08 §7, channel `advisor`): a
 * doctor found by the public search, a free time held a few minutes by the patient's mobile,
 * then requested. Booking decides at every step (ADR-027); the visit is booked.
 */
export function AdvisorBooking({
  caseId,
  mobile,
  name,
  fieldCode,
  cityCode,
  today,
}: {
  caseId: string;
  mobile: string;
  name: string | null;
  fieldCode: string;
  cityCode: string | null;
  today: JalaliDate;
}) {
  const api = useApi();
  const [results, setResults] = useState<readonly Result[] | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [day, setDay] = useState<JalaliDate | null>(null);
  const [held, setHeld] = useState<AppointmentViewBody | null>(null);
  const [done, setDone] = useState<AppointmentViewBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const serviceCode = chosen?.result.price?.serviceCode ?? null;
  const { byDay, capacity } = useMemo(() => {
    const days: Record<string, DaySlot[]> = {};
    for (const s of chosen?.slots ?? []) {
      if (serviceCode && !s.serviceCodes.includes(serviceCode)) continue;
      const key = dayKey(toJalali(new Date(s.startsAt)));
      (days[key] ??= []).push({
        startsAt: s.startsAt,
        time: wallTime(s.startsAt),
        available: true,
      });
    }
    const full: Record<string, Capacity> = {};
    for (const [key, list] of Object.entries(days)) {
      full[key] = list.length >= PLENTY ? 'free' : 'limited';
    }
    return { byDay: days, capacity: full };
  }, [chosen, serviceCode]);

  const step = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Notice
        tone="success"
        title={done.status === 'confirmed' ? 'نوبت تأیید شد' : 'درخواست نوبت ثبت شد'}
      >
        <p>
          {chosen?.result.doctor.name}، {showInstant(done.startsAt)}. پیامک برای بیمار فرستاده
          می‌شود.
        </p>
        <Link href={`/leads/${caseId}`} className="font-medium text-accent underline">
          بازگشت به پرونده
        </Link>
      </Notice>
    );
  }

  if (held && chosen) {
    return (
      <section aria-labelledby="review" className="max-w-lg space-y-3">
        <h2 id="review" className="text-[length:var(--text-lg)] font-bold">
          بررسی و ثبت نوبت
        </h2>
        <dl className="space-y-2 rounded-lg border border-border bg-surface p-4">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">پزشک</dt>
            <dd>{chosen.result.doctor.name}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">زمان</dt>
            <dd className="figures">{showInstant(held.startsAt)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">بیمار</dt>
            <dd dir="ltr">{faDigits(`0${mobile}`)}</dd>
          </div>
        </dl>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className={buttonClass('primary')}
            onClick={() =>
              void step(async () => {
                setDone(
                  await unwrap(
                    api.POST('/api/v1/booking/advisor/appointments/{id}/request', {
                      params: { path: { id: held.id } },
                    }),
                  ),
                );
              })
            }
          >
            ثبت درخواست نوبت
          </button>
          <button
            type="button"
            disabled={busy}
            className={buttonClass('secondary')}
            onClick={() => {
              setHeld(null);
              setError(null);
            }}
          >
            انتخاب زمان دیگر
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const q = formText(e.currentTarget, 'q').trim();
          void step(async () => {
            const found = await unwrap(
              api.GET('/api/v1/search/doctors', {
                params: {
                  query: {
                    fieldCode,
                    ...(cityCode ? { cityCode } : {}),
                    ...(q ? { q } : {}),
                  },
                },
              }),
            );
            setChosen(null);
            setResults(found.results);
          });
        }}
      >
        <TextField id="doctor-q" name="q" label="نام پزشک یا مرکز" className="min-w-64 grow" />
        <button type="submit" disabled={busy} className={buttonClass('secondary')}>
          جست‌وجو
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {results &&
        (results.length === 0 ? (
          <Notice tone="info">پزشکی با این رشته و شهر پیدا نشد.</Notice>
        ) : (
          <ul className="space-y-2" aria-label="پزشکان">
            {results.map((r) => (
              <li
                key={r.workplaceId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
              >
                <span>
                  <span className="font-medium">{r.doctor.name}</span>
                  {r.placeName && <span className="text-ink-muted"> · {r.placeName}</span>}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass(
                    chosen?.result.workplaceId === r.workplaceId ? 'primary' : 'secondary',
                    'min-h-9 px-3',
                  )}
                  onClick={() =>
                    void step(async () => {
                      const range = {
                        from: apiDay(today),
                        to: apiDay(addJalaliDays(today, DAYS_AHEAD)),
                      };
                      const [slots, holidays] = await Promise.all([
                        unwrap(
                          api.GET('/api/v1/booking/workplaces/{id}/free-slots', {
                            params: { path: { id: r.workplaceId }, query: range },
                          }),
                        ),
                        unwrap(
                          api.GET('/api/v1/calendar/holidays', {
                            params: { query: { ...range, cityCode: r.cityCode } },
                          }),
                        ).catch(() => []),
                      ]);
                      setDay(null);
                      setChosen({
                        result: r,
                        slots,
                        holidays: holidays.map((h) => ({ on: h.on, title: h.title })),
                      });
                    })
                  }
                >
                  انتخاب
                </button>
              </li>
            ))}
          </ul>
        ))}
      {chosen &&
        (Object.keys(byDay).length === 0 ? (
          <Notice tone="info">در روزهای پیش رو زمان آزادی برای این پزشک نیست.</Notice>
        ) : (
          <div className="max-w-md">
            <Calendar
              mode="single"
              label="روز و ساعت نوبت"
              value={day}
              onChange={setDay}
              today={today}
              min={today}
              holidays={chosen.holidays}
              capacity={capacity}
              slots={byDay}
              onPickTime={(slot) => {
                if (busy || !serviceCode) return;
                void step(async () => {
                  setHeld(
                    await unwrap(
                      api.POST('/api/v1/booking/advisor/appointments/hold', {
                        params: { header: { 'idempotency-key': crypto.randomUUID() } },
                        body: {
                          workplaceId: chosen.result.workplaceId,
                          serviceCode,
                          startsAt: slot.startsAt,
                          mobile,
                          ...(name ? { name } : {}),
                        },
                      }),
                    ),
                  );
                });
              }}
            />
          </div>
        ))}
    </div>
  );
}
