import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  defined,
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  one,
  PageHeader,
  pageOf,
  Pagination,
  SelectField,
  showInstant,
  StatusBadge,
  toman,
  withParams,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CREDIT_STATUS } from '../../../lib/credit';
import { serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'تکمیل پرونده | پنل داخلی سپهر' };

const PAGE_SIZE = 20;

/** Decided in favour: what completion works on (doc 12 §4). */
const STATES = ['approved', 'conditional'] as const;

/**
 * The completion queue (task 4-4): approved and conditionally approved applications,
 * paged on the server. Whether one is completed is on its own page, from the service.
 */
export default async function CompletionQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const status = STATES.find((s) => s === one(params, 'status')) ?? 'approved';
  const page = pageOf(params);
  const api = await serverApi();
  let result;
  let failure: unknown = null;
  try {
    result = await unwrap(
      api.GET('/api/v1/credit/applications', {
        params: { query: defined({ status, page: String(page), pageSize: String(PAGE_SIZE) }) },
      }),
    );
  } catch (error) {
    failure = error;
  }

  return (
    <>
      <PageHeader title="تکمیل پرونده" />
      <p>
        <Link href="/receipts" className="text-accent underline">
          صف تأیید فیش‌ها (مالی)
        </Link>
      </p>
      <FilterBar action="/completion" resetHref="/completion">
        <SelectField
          id="status"
          name="status"
          label="وضعیت تصمیم"
          defaultValue={status}
          options={STATES.map((s) => ({ value: s, label: CREDIT_STATUS[s].label }))}
        />
      </FilterBar>
      {failure || !result ? (
        <Notice tone="danger">{errorMessage(failure)}</Notice>
      ) : (
        <>
          <DataTable
            caption="پرونده‌های در صف تکمیل"
            rows={result.items}
            rowKey={(a) => a.id}
            empty={<EmptyState title="پرونده‌ای در این وضعیت نیست." />}
            columns={[
              { key: 'created', header: 'ثبت', cell: (a) => showInstant(a.createdAt) },
              {
                key: 'plan',
                header: 'طرح',
                cell: (a) => `${a.planTitle} · ${faDigits(a.installmentCount)} قسط`,
              },
              {
                key: 'amount',
                header: 'مبلغ مصوب',
                cell: (a) => toman(a.approvedAmountRial ?? a.loanRial),
                numeric: true,
              },
              {
                key: 'status',
                header: 'وضعیت',
                cell: (a) => (
                  <StatusBadge tone={CREDIT_STATUS[a.status].tone}>
                    {CREDIT_STATUS[a.status].label}
                  </StatusBadge>
                ),
              },
              {
                key: 'open',
                header: 'تکمیل',
                cell: (a) => (
                  <Link href={`/completion/${a.id}`} className="text-accent underline">
                    چک‌لیست
                  </Link>
                ),
              },
            ]}
          />
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            hrefFor={(p) => withParams('/completion', params, { page: p })}
          />
        </>
      )}
    </>
  );
}
