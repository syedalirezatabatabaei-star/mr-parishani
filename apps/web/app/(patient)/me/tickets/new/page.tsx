import { unwrap } from '@sepehr/api-client';
import {
  errorMessage,
  NewTicketForm,
  Notice,
  PageHeader,
  showInstantDay,
  type TicketLinkOption,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'تیکت تازه | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * A new ticket (task 7-7; doc 17 §1): a topic, and optionally one of the patient's own
 * appointments or proformas to point at. The API checks the link again (test 2).
 */
export default async function NewTicketPage() {
  const api = await serverApi();
  let topics;
  let links: TicketLinkOption[];
  try {
    const [t, appointments, proformas] = await Promise.all([
      unwrap(api.GET('/api/v1/me/tickets/topics')),
      unwrap(
        api.GET('/api/v1/booking/me/appointments', {
          params: { query: { page: '1', pageSize: '20' } },
        }),
      ),
      unwrap(api.GET('/api/v1/me/proformas')),
    ]);
    topics = t;
    links = [
      ...appointments.items.map((a) => ({
        type: 'appointment' as const,
        id: a.id,
        label: `نوبت ${a.doctor.name}، ${showInstantDay(a.startsAt)}`,
      })),
      ...proformas
        .filter((p) => p.status !== 'draft' && p.status !== 'superseded')
        .map((p) => ({
          type: 'proforma' as const,
          id: p.id,
          label: `پیش‌فاکتور ${p.placeName ?? ''}`.trim(),
        })),
    ];
  } catch (error) {
    return (
      <>
        <PageHeader title="تیکت تازه" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="تیکت تازه"
        description="موضوع را انتخاب کنید و پرسش یا شکایت خود را بنویسید. پاسخ را در «پشتیبانی» می‌بینید."
      />
      <Link href="/me/tickets" className="text-accent underline">
        بازگشت به تیکت‌ها
      </Link>
      <NewTicketForm side="me" topics={topics} links={links} hrefBase="/me/tickets" />
    </>
  );
}
