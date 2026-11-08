'use client';

import { unwrap } from '@sepehr/api-client';
import {
  toJalali,
  toJalaliDateTime,
  type AppointmentViewBody,
  type JalaliDate,
  type PublicWorkplace,
} from '@sepehr/contracts';
import {
  buttonClass,
  Calendar,
  dayKey,
  errorMessage,
  faDigits,
  Notice,
  SelectField,
  showInstant,
  showInstantDay,
  showTime,
  toman,
  useApi,
  type Capacity,
  type DaySlot,
  type HolidayMark,
} from '@sepehr/ui';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

interface FreeSlot {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly serviceCodes: readonly string[];
}

type Step =
  | { kind: 'pick' }
  | { kind: 'review'; hold: AppointmentViewBody }
  | { kind: 'done'; appointment: AppointmentViewBody };

/** A day with this many free times or more is «free»; fewer is «limited» (a display rule). */
const PLENTY = 4;

const wallTime = (iso: string) => {
  const t = toJalaliDateTime(new Date(iso));
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
};

const priceText = (s: PublicWorkplace['services'][number]) =>
  s.isFree
    ? 'رایگان'
    : s.minRial === s.maxRial
      ? toman(s.minRial)
      : `${toman(s.minRial)} تا ${toman(s.maxRial)}`;

/** Seconds left until `iso`, ticking each second; never below zero. */
function useSecondsLeft(iso: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [iso]);
  return iso ? Math.max(0, Math.round((Date.parse(iso) - now) / 1000)) : 0;
}

/**
 * Choose a service, a day and a time; the slot is held for a few minutes while the patient
 * reviews it, then the request goes to the center (or is confirmed at once in automatic
 * mode). The API decides at every step (ADR-027): a taken slot is said plainly.
 */
export function BookingFlow({
  workplace,
  slots,
  holidays,
  today,
  preselect,
}: {
  workplace: PublicWorkplace;
  slots: readonly FreeSlot[];
  holidays: readonly HolidayMark[];
  today: JalaliDate;
  preselect: string | null;
}) {
  const api = useApi();
  const visit = workplace.services.find((s) => s.isVisit) ?? workplace.services[0];
  const preselected = preselect ? slots.find((s) => s.startsAt === preselect) : undefined;
  const [serviceCode, setServiceCode] = useState(visit?.serviceCode ?? '');
  const [day, setDay] = useState<JalaliDate | null>(
    preselected ? toJalali(new Date(preselected.startsAt)) : null,
  );
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const service = workplace.services.find((s) => s.serviceCode === serviceCode);

  // The times of each Tehran day for the chosen service, and how full each day is.
  const { byDay, capacity } = useMemo(() => {
    const days: Record<string, DaySlot[]> = {};
    for (const s of slots) {
      if (!s.serviceCodes.includes(serviceCode)) continue;
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
  }, [slots, serviceCode]);

  const hold = async (slot: DaySlot) => {
    setBusy(true);
    setError(null);
    try {
      const held = await unwrap(
        api.POST('/api/v1/booking/appointments/hold', {
          params: { header: { 'idempotency-key': crypto.randomUUID() } },
          body: { workplaceId: workplace.workplaceId, serviceCode, startsAt: slot.startsAt },
        }),
      );
      setStep({ kind: 'review', hold: held });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (held: AppointmentViewBody) => {
    setBusy(true);
    setError(null);
    try {
      const appointment = await unwrap(
        api.POST('/api/v1/booking/appointments/{id}/request', {
          params: { path: { id: held.id } },
        }),
      );
      setStep({ kind: 'done', appointment });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const secondsLeft = useSecondsLeft(step.kind === 'review' ? step.hold.holdExpiresAt : null);

  if (step.kind === 'done') {
    const confirmed = step.appointment.status === 'confirmed';
    return (
      <div className="space-y-4">
        <Notice tone="success" title={confirmed ? 'نوبت شما تأیید شد' : 'درخواست نوبت ثبت شد'}>
          <p>
            {workplace.doctor.name}، {showInstantDay(step.appointment.startsAt)} ساعت{' '}
            {showTime(step.appointment.startsAt)}.
          </p>
          <p>
            {confirmed
              ? 'پیامک تأیید برای شما فرستاده می‌شود.'
              : 'مرکز درخواست را بررسی می‌کند و نتیجه را پیامک می‌کنیم.'}
          </p>
        </Notice>
        <Link href="/me/appointments" className={buttonClass('primary')}>
          نوبت‌های من
        </Link>
      </div>
    );
  }

  if (step.kind === 'review') {
    const expired = secondsLeft === 0;
    return (
      <section aria-labelledby="review-title" className="max-w-lg space-y-4">
        <h2 id="review-title" className="text-[length:var(--text-lg)] font-bold">
          بررسی و ثبت نوبت
        </h2>
        <dl className="space-y-2 rounded-lg border border-border bg-surface p-4">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">پزشک</dt>
            <dd>{workplace.doctor.name}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">خدمت</dt>
            <dd>{service?.serviceName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">زمان</dt>
            <dd className="figures">{showInstant(step.hold.startsAt)}</dd>
          </div>
          {service && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">هزینه</dt>
              <dd className="figures">{priceText(service)}</dd>
            </div>
          )}
        </dl>
        {expired ? (
          <Notice tone="warning">
            مهلت نگه‌داشتن این زمان تمام شد. زمان را دوباره انتخاب کنید.
          </Notice>
        ) : (
          <p className="text-[length:var(--text-sm)] text-ink-muted" aria-live="polite">
            این زمان تا{' '}
            <span className="figures">
              {faDigits(Math.floor(secondsLeft / 60))}:
              {faDigits(String(secondsLeft % 60).padStart(2, '0'))}
            </span>{' '}
            دیگر برای شما نگه داشته می‌شود.
          </p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || expired}
            className={buttonClass('primary')}
            onClick={() => void submit(step.hold)}
          >
            ثبت درخواست نوبت
          </button>
          <button
            type="button"
            disabled={busy}
            className={buttonClass('secondary')}
            onClick={() => {
              setStep({ kind: 'pick' });
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
      {workplace.services.length > 1 && (
        <div className="max-w-sm">
          <SelectField
            id="service"
            name="service"
            label="خدمت"
            defaultValue={serviceCode}
            options={workplace.services.map((s) => ({
              value: s.serviceCode,
              label: `${s.serviceName} (${priceText(s)})`,
            }))}
            onChange={setServiceCode}
          />
        </div>
      )}
      {workplace.services.length === 1 && service && (
        <p className="text-[length:var(--text-sm)]">
          {service.serviceName}: <span className="figures">{priceText(service)}</span>
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {Object.keys(byDay).length === 0 ? (
        <Notice tone="info">در روزهای پیش رو زمان آزادی برای این خدمت نیست.</Notice>
      ) : (
        <div className="max-w-md">
          <Calendar
            mode="single"
            label="روز و ساعت نوبت"
            value={day}
            onChange={setDay}
            today={today}
            min={today}
            holidays={holidays}
            capacity={capacity}
            slots={byDay}
            onPickTime={(slot) => {
              if (!busy) void hold(slot);
            }}
          />
        </div>
      )}
    </div>
  );
}
