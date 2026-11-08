import { ApiError, unwrap } from '@sepehr/api-client';
import { addJalaliDays } from '@sepehr/contracts';
import { Notice, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cityNamer } from '../../../../lib/cities';
import { apiDay, one, tehranToday, type SearchParams } from '../../../../lib/params';
import { serverApi } from '../../../../lib/server-api';
import { BookingFlow } from './booking-flow';

export const metadata: Metadata = {
  title: 'انتخاب زمان و نوبت | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/** How far ahead the calendar asks for free times: the API cuts it at the booking horizon. */
const DAYS_AHEAD = 61;

/**
 * Choosing a time and booking (doc 08 §7, ADR-027): the patient is signed in (proxy.ts);
 * the free times come from booking, which still decides when the slot is held.
 */
export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ workplaceId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { workplaceId } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(workplaceId)) notFound();
  const api = await serverApi();
  const today = tehranToday();
  const range = { from: apiDay(today), to: apiDay(addJalaliDays(today, DAYS_AHEAD)) };

  const workplace = await unwrap(
    api.GET('/api/v1/public/workplaces/{id}', { params: { path: { id: workplaceId } } }),
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.notFound) notFound();
    throw error;
  });
  const [slots, holidays] = await Promise.all([
    unwrap(
      api.GET('/api/v1/booking/workplaces/{id}/free-slots', {
        params: { path: { id: workplaceId }, query: range },
      }),
    ).catch((error: unknown) => error),
    unwrap(
      api.GET('/api/v1/calendar/holidays', {
        params: { query: { ...range, cityCode: workplace.cityCode } },
      }),
    ).catch(() => []),
  ]);

  const cityName = await cityNamer();
  return (
    <>
      <PageHeader
        title={`نوبت ${workplace.doctor.name}`}
        description={[
          workplace.treatmentFields.map((f) => f.name).join('، '),
          workplace.placeName,
          workplace.branchName === workplace.placeName ? null : workplace.branchName,
          cityName(workplace.cityCode),
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      {workplace.address && (
        <p className="text-[length:var(--text-sm)] text-ink-muted">نشانی: {workplace.address}</p>
      )}
      {slots instanceof ApiError && slots.code === 'patients_only' ? (
        <Notice tone="warning" title="نوبت فقط با حساب بیمار گرفته می‌شود">
          با حساب کارکنان وارد شده‌اید. برای نوبت گرفتن از حساب کاربری بیمار استفاده کنید.
        </Notice>
      ) : slots instanceof Error || !Array.isArray(slots) ? (
        <Notice tone="danger">زمان‌های آزاد خوانده نشد. کمی بعد دوباره تلاش کنید.</Notice>
      ) : (
        <BookingFlow
          workplace={workplace}
          slots={slots}
          holidays={holidays.map((h) => ({ on: h.on, title: h.title }))}
          today={today}
          preselect={one(query, 'at') ?? null}
        />
      )}
    </>
  );
}
