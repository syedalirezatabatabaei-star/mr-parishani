import { ApiError, unwrap } from '@sepehr/api-client';
import { Notice, PageHeader, tehranToday } from '@sepehr/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverApi } from '../../../../../lib/server-api';
import { AdvisorBooking } from './advisor-booking';

export const metadata: Metadata = { title: 'نوبت برای بیمار | پنل داخلی سپهر' };

/**
 * Booking for the patient of a case (owner 1405/07/24, م۹; `booking.book_for_patient`): by
 * the case's first approved mobile, which the appointment and its SMS go to.
 */
export default async function BookForPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const api = await serverApi();
  const kase = await unwrap(api.GET('/api/v1/lead/cases/{id}', { params: { path: { id } } })).catch(
    (error: unknown) => {
      if (error instanceof ApiError && error.notFound) notFound();
      throw error;
    },
  );
  const mobile = kase.person.mobiles[0];
  return (
    <>
      <PageHeader
        title="نوبت برای بیمار"
        description={kase.person.displayName ?? 'پرونده بی نام'}
      />
      {mobile === undefined || kase.person.blocked ? (
        <Notice tone="warning">
          این پرونده موبایل تأییدشده ندارد یا شخص مسدود است؛ نوبت گرفته نمی‌شود.
        </Notice>
      ) : (
        <AdvisorBooking
          caseId={kase.id}
          mobile={mobile}
          name={kase.person.displayName}
          fieldCode={kase.treatmentFieldCode}
          cityCode={kase.cityCode}
          today={tehranToday()}
        />
      )}
    </>
  );
}
