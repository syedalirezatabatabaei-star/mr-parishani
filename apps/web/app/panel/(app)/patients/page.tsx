import { unwrap } from '@sepehr/api-client';
import { DataTable, EmptyState, errorMessage, Notice, PageHeader, StatusBadge } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'بیماران اعتباری | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * The funded patients referred to this doctor (doc 12 §6; task 4-7): the name and whether a
 * service can be authorized now, nothing more (owner, task 4-6 پ۲): no amount, balance or
 * score. The amount of a service is seen only when authorizing it, from the proforma.
 */
export default async function PanelPatientsPage() {
  const api = await serverApi();
  let patients;
  try {
    patients = await unwrap(api.GET('/api/v1/service/patients'));
  } catch (error) {
    return (
      <>
        <PageHeader title="بیماران اعتباری" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="بیماران اعتباری"
        description="بیمارانی که کیف اعتبارشان شارژ شده و به شما معرفی شده‌اند."
      />
      <DataTable
        caption="بیماران اعتباری"
        rows={patients}
        rowKey={(p) => p.purseId}
        empty={<EmptyState title="بیمار شارژشده‌ای به شما معرفی نشده است." />}
        columns={[
          { key: 'name', header: 'بیمار', cell: (p) => p.patientName ?? '—' },
          {
            key: 'allowed',
            header: 'وضعیت',
            cell: (p) =>
              p.allowed ? (
                <StatusBadge tone="success">مجاز</StatusBadge>
              ) : (
                <StatusBadge tone="neutral">غیرمجاز</StatusBadge>
              ),
          },
          {
            key: 'authorize',
            header: 'مجوز خدمت',
            cell: (p) =>
              p.allowed ? (
                <Link href={`/panel/patients/${p.purseId}`} className="text-accent underline">
                  صدور مجوز خدمت
                </Link>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </>
  );
}
