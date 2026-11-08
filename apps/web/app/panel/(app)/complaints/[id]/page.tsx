import { unwrap } from '@sepehr/api-client';
import {
  errorMessage,
  Notice,
  PageHeader,
  StatusBadge,
  TICKET_STATUS,
  TicketThread,
  ticketTitle,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../../lib/server-api';
import { RespondForm } from './respond-form';

export const metadata: Metadata = {
  title: 'شکایت بیمار | پنل مرکز',
  robots: { index: false, follow: false },
};

const ANSWERABLE = new Set(['open', 'assigned', 'in_progress', 'waiting_on_requester', 'reopened']);

/** A patient's complaint about this doctor (task 7-7): its public part, and the answer. */
export default async function ComplaintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let ticket;
  try {
    ticket = await unwrap(api.GET('/api/v1/panel/complaints/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="شکایت بیمار" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title={ticketTitle(ticket)} />
      <Link href="/panel/complaints" className="text-accent underline">
        همه شکایت‌ها
      </Link>
      <p>
        <StatusBadge tone={TICKET_STATUS[ticket.status].tone}>
          {TICKET_STATUS[ticket.status].label}
        </StatusBadge>
      </p>
      <TicketThread
        reader="respondent"
        messages={ticket.messages}
        attachments={[]}
        links={ticket.links}
      />
      {ANSWERABLE.has(ticket.status) && <RespondForm id={ticket.id} />}
    </>
  );
}
