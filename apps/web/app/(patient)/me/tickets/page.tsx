import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  TICKET_KIND,
  TICKET_STATUS,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'پشتیبانی | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/** The patient's tickets and complaints (task 7-7; doc 17 §1): the latest first. */
export default async function MyTicketsPage() {
  const api = await serverApi();
  let tickets;
  try {
    tickets = await unwrap(api.GET('/api/v1/me/tickets'));
  } catch (error) {
    return (
      <>
        <PageHeader title="پشتیبانی" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="پشتیبانی"
        description="پرسش، درخواست یا شکایت خود را ثبت کنید و پاسخ کارشناس را همین‌جا ببینید."
        actions={
          <Link href="/me/tickets/new" className={buttonClass('primary')}>
            تیکت تازه
          </Link>
        }
      />
      {tickets.length === 0 ? (
        <EmptyState title="هنوز تیکتی ثبت نکرده‌اید." />
      ) : (
        <ul className="space-y-3" aria-label="فهرست تیکت‌ها">
          {tickets.map((t) => (
            <li key={t.id} className="space-y-2 rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-bold">
                  {TICKET_KIND[t.kind]} <span className="figures">{faDigits(t.number)}</span>:{' '}
                  {t.subject}
                </p>
                <StatusBadge tone={TICKET_STATUS[t.status].tone}>
                  {TICKET_STATUS[t.status].label}
                </StatusBadge>
              </div>
              <p className="text-[length:var(--text-sm)] text-ink-muted">
                ثبت: <span className="figures">{showInstant(t.openedAt)}</span>
              </p>
              <Link href={`/me/tickets/${t.id}`} className="text-accent underline">
                مشاهده گفتگو
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
