import { unwrap } from '@sepehr/api-client';
import { PARTNERSHIP_STATUSES, PLACE_KIND_NAMES } from '@sepehr/contracts';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  navLinkClass,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cityNamer } from '../../../lib/cities';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { PARTNERSHIP_STATUS } from './labels';

export const metadata: Metadata = { title: 'درخواست‌های همکاری | پنل داخلی سپهر' };

/**
 * The partnership requests (owner 1405/08/10): the network specialist reviews the pending ones
 * and registers each center as a draft; the network manager, another person, approves the
 * reviewed ones. Newest first, by status.
 */
export default async function PartnershipQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [session, query] = await Promise.all([getSession(), searchParams]);
  const status = PARTNERSHIP_STATUSES.find((s) => s === query['status']);
  const reviewer = can(session, 'catalog.review_partnership');
  const approver = can(session, 'catalog.approve_partnership');
  // Each person's own work first: the specialist's pending, the manager's reviewed.
  const shown = status ?? (approver && !reviewer ? 'reviewed' : 'pending');
  let rows;
  try {
    rows = await unwrap(
      (await serverApi()).GET('/api/v1/catalog/partnership-requests', {
        params: { query: { status: shown } },
      }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="درخواست‌های همکاری" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const city = await cityNamer();
  return (
    <>
      <PageHeader
        title="درخواست‌های همکاری"
        description="مراکز و پزشکانی که از صفحه عمومی درخواست همکاری داده‌اند؛ تأیید اولیه با کارشناس شبکه درمان، تأیید نهایی با مدیر شبکه درمان."
      />
      <nav aria-label="وضعیت درخواست‌ها">
        <ul className="flex flex-wrap gap-1 text-[length:var(--text-sm)]">
          {PARTNERSHIP_STATUSES.map((s) => (
            <li key={s}>
              <Link
                href={`/partnership?status=${s}`}
                aria-current={s === shown ? 'page' : undefined}
                className={navLinkClass(s === shown)}
              >
                {PARTNERSHIP_STATUS[s].label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <DataTable
        caption="درخواست‌های همکاری"
        rows={rows}
        rowKey={(r) => r.id}
        empty={<EmptyState title="درخواستی در این وضعیت نیست." />}
        columns={[
          {
            key: 'number',
            header: 'کد پیگیری',
            numeric: true,
            cell: (r) => (
              <Link href={`/partnership/${r.id}`} className="font-bold text-accent underline">
                {faDigits(r.number)}
              </Link>
            ),
          },
          { key: 'name', header: 'مرکز', cell: (r) => r.centerName },
          { key: 'kind', header: 'نوع', cell: (r) => PLACE_KIND_NAMES[r.placeKind] },
          { key: 'city', header: 'شهر', cell: (r) => city(r.cityCode) },
          { key: 'manager', header: 'مسئول', cell: (r) => r.managerName },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (r) => (
              <StatusBadge tone={PARTNERSHIP_STATUS[r.status].tone}>
                {PARTNERSHIP_STATUS[r.status].label}
              </StatusBadge>
            ),
          },
          {
            key: 'at',
            header: 'زمان',
            cell: (r) => <span className="figures">{showInstant(r.createdAt)}</span>,
          },
        ]}
      />
    </>
  );
}
