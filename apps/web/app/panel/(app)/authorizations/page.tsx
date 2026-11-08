import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  Notice,
  PageHeader,
  rial,
  SERVICE_STATUS,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'تاریخچه خدمات | پنل مرکز',
  robots: { index: false, follow: false },
};

/** The service authorizations of the workplaces the caller covers, newest first (task 4-7). */
export default async function AuthorizationsPage() {
  const api = await serverApi();
  let rows;
  try {
    rows = await unwrap(api.GET('/api/v1/service/authorizations'));
  } catch (error) {
    return (
      <>
        <PageHeader title="تاریخچه خدمات" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title="تاریخچه خدمات" description="مجوزهای خدمت صادرشده و وضعیت هر یک." />
      <DataTable
        caption="مجوزهای خدمت"
        rows={rows}
        rowKey={(a) => a.id}
        empty={<EmptyState title="هنوز مجوز خدمتی صادر نشده است." />}
        columns={[
          { key: 'issued', header: 'صدور', cell: (a) => showInstant(a.issuedAt) },
          { key: 'amount', header: 'مبلغ', cell: (a) => rial(a.amountRial), numeric: true },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (a) => (
              <StatusBadge tone={SERVICE_STATUS[a.status].tone}>
                {SERVICE_STATUS[a.status].label}
              </StatusBadge>
            ),
          },
          {
            key: 'open',
            header: 'جزئیات',
            cell: (a) => (
              <Link href={`/panel/authorizations/${a.id}`} className="text-accent underline">
                مشاهده
              </Link>
            ),
          },
        ]}
      />
    </>
  );
}
