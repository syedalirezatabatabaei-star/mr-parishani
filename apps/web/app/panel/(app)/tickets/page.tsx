import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  TICKET_KIND,
  TICKET_STATUS,
  TicketDeadline,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'تیکت‌ها | پنل مرکز',
  robots: { index: false, follow: false },
};

/** The center's tickets and complaints (task 7-7; doc 17 §1), from the nodes it covers. */
export default async function PanelTicketsPage() {
  const api = await serverApi();
  let tickets;
  try {
    tickets = await unwrap(api.GET('/api/v1/panel/tickets'));
  } catch (error) {
    return (
      <>
        <PageHeader title="تیکت‌ها" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const now = new Date();
  return (
    <>
      <PageHeader
        title="تیکت‌ها"
        description="پرسش، درخواست یا شکایت مالی خود را برای واحد مربوط ثبت و پیگیری کنید."
        actions={
          <Link href="/panel/tickets/new" className={buttonClass('primary')}>
            تیکت تازه
          </Link>
        }
      />
      <DataTable
        caption="تیکت‌های مرکز"
        rows={tickets}
        rowKey={(t) => t.id}
        empty={<EmptyState title="تیکتی ثبت نشده است." />}
        columns={[
          {
            key: 'number',
            header: 'شماره',
            cell: (t) => (
              <Link href={`/panel/tickets/${t.id}`} className="text-accent underline">
                {TICKET_KIND[t.kind]} {faDigits(t.number)}
              </Link>
            ),
          },
          { key: 'subject', header: 'عنوان', cell: (t) => t.subject },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (t) => (
              <StatusBadge tone={TICKET_STATUS[t.status].tone}>
                {TICKET_STATUS[t.status].label}
              </StatusBadge>
            ),
          },
          { key: 'opened', header: 'ثبت', cell: (t) => showInstant(t.openedAt) },
          {
            key: 'due',
            header: 'مهلت پاسخ',
            cell: (t) => <TicketDeadline dueAt={t.dueAt} paused={t.paused} now={now} />,
          },
        ]}
      />
    </>
  );
}
