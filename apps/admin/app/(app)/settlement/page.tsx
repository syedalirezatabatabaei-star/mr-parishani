import { unwrap } from '@sepehr/api-client';
import { STATEMENT_STATUSES, type StatementStatus } from '@sepehr/contracts';
import {
  DataTable,
  EmptyState,
  errorMessage,
  FilterBar,
  Notice,
  PageHeader,
  SelectField,
  showInstant,
  showJalaliMonth,
  STATEMENT_STATUS,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'صورت‌وضعیت پزشکان | پنل داخلی سپهر' };

const money = (rial: string) =>
  rial.startsWith('-') ? `منفی ${toman(rial.slice(1))}` : toman(rial);

/**
 * Accounting's queue of doctors' statements (task 5-7; doc 06 §5): drafts to review, reviewed
 * ones to approve by someone else, approved ones to pay. Each opens to its items and orders.
 */
export default async function SettlementQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const asked = typeof params['status'] === 'string' ? params['status'] : 'draft';
  const status = (STATEMENT_STATUSES as readonly string[]).includes(asked)
    ? (asked as StatementStatus)
    : 'draft';
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let rows;
  try {
    rows = await unwrap(
      api.GET('/api/v1/settlement/statements', { params: { query: { status } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="صورت‌وضعیت پزشکان" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="صورت‌وضعیت پزشکان"
        description="بررسی، تأیید دوم با شخص دیگر، و پرداخت با کد رهگیری بانک."
      />
      <nav aria-label="گزارش‌های تسویه" className="flex gap-4">
        {can(session, 'settlement.read_reports') && (
          <Link href="/settlement/reports" className="text-accent underline">
            اقلام معلق و مانده منفی
          </Link>
        )}
        {can(session, 'settlement.manage_odoo_mapping') && (
          <Link href="/settlement/odoo" className="text-accent underline">
            خروجی Odoo
          </Link>
        )}
      </nav>
      <FilterBar action="/settlement" label="وضعیت صورت‌وضعیت" submitLabel="نمایش">
        <SelectField
          id="status"
          name="status"
          label="وضعیت"
          defaultValue={status}
          options={STATEMENT_STATUSES.map((s) => ({ value: s, label: STATEMENT_STATUS[s].label }))}
        />
      </FilterBar>
      <DataTable
        caption="صورت‌وضعیت‌ها"
        rows={rows}
        rowKey={(s) => s.id}
        empty={<EmptyState title="صورت‌وضعیتی با این وضعیت نیست." />}
        columns={[
          {
            key: 'month',
            header: 'دوره',
            cell: (s) => showJalaliMonth(s.periodYear, s.periodMonth),
          },
          {
            key: 'gross',
            header: 'خدمات',
            cell: (s) => money(s.grossCreditServicesRial),
            numeric: true,
          },
          {
            key: 'payable',
            header: 'قابل پرداخت',
            cell: (s) => money(s.payableRial),
            numeric: true,
          },
          { key: 'made', header: 'ساخت', cell: (s) => showInstant(s.generatedAt) },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (s) => (
              <StatusBadge tone={STATEMENT_STATUS[s.status].tone}>
                {STATEMENT_STATUS[s.status].label}
              </StatusBadge>
            ),
          },
          {
            key: 'open',
            header: 'جزئیات',
            cell: (s) => (
              <Link href={`/settlement/${s.id}`} className="text-accent underline">
                مشاهده
              </Link>
            ),
          },
        ]}
      />
    </>
  );
}
