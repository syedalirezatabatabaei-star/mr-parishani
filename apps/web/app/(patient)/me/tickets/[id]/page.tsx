import { unwrap } from '@sepehr/api-client';
import { errorMessage, Notice, PageHeader, RequesterTicket, ticketTitle } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'تیکت | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/** One of the patient's tickets (task 7-7): only its public messages and files (test 3). */
export default async function MyTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let ticket;
  try {
    ticket = await unwrap(api.GET('/api/v1/me/tickets/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="تیکت" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title={ticketTitle(ticket)} />
      <Link href="/me/tickets" className="text-accent underline">
        همه تیکت‌ها
      </Link>
      <RequesterTicket side="me" ticket={ticket} now={new Date()} />
    </>
  );
}
