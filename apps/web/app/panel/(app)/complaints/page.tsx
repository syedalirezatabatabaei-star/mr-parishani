import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  TICKET_STATUS,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'شکایت‌های بیماران | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * Patients' complaints about this doctor (task 7-7; doc 17 §1), to answer. The patient's
 * contact is never here; the answer goes back to them through support.
 */
export default async function ComplaintsPage() {
  const api = await serverApi();
  let complaints;
  try {
    complaints = await unwrap(api.GET('/api/v1/panel/complaints'));
  } catch (error) {
    return (
      <>
        <PageHeader title="شکایت‌های بیماران" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="شکایت‌های بیماران"
        description="شکایت بیمار درباره نوبت یا پیش‌فاکتور شما؛ پاسخ شما برای بیمار فرستاده می‌شود."
      />
      <DataTable
        caption="شکایت‌ها"
        rows={complaints}
        rowKey={(t) => t.id}
        empty={<EmptyState title="شکایتی نیست." />}
        columns={[
          {
            key: 'number',
            header: 'شماره',
            cell: (t) => (
              <Link href={`/panel/complaints/${t.id}`} className="text-accent underline">
                شکایت {faDigits(t.number)}
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
        ]}
      />
    </>
  );
}
