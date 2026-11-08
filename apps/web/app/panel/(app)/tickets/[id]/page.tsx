import { unwrap } from '@sepehr/api-client';
import { errorMessage, Notice, PageHeader, RequesterTicket, ticketTitle } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'تیکت | پنل مرکز',
  robots: { index: false, follow: false },
};

/** One of the center's tickets (task 7-7): its public part only (test 3). */
export default async function PanelTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let ticket;
  try {
    ticket = await unwrap(api.GET('/api/v1/panel/tickets/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="تیکت" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const financial = ticket.links.some(
    (l) => l.type === 'doctor_payable' || l.type === 'service_fee',
  );
  const decided = ticket.status === 'resolved' || ticket.status === 'closed';
  return (
    <>
      <PageHeader title={ticketTitle(ticket)} />
      <Link href="/panel/tickets" className="text-accent underline">
        همه تیکت‌ها
      </Link>
      {financial && !decided && (
        <Notice tone="info">
          قلم مورد اعتراض تا تعیین تکلیف حسابداری در صورت‌وضعیت نمی‌آید. این شکایت با همان تصمیم
          بسته می‌شود.
        </Notice>
      )}
      <RequesterTicket side="panel" ticket={ticket} now={new Date()} />
    </>
  );
}
