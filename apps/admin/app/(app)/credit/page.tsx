import { unwrap } from '@sepehr/api-client';
import { CREDIT_APPLICATION_STATUSES, CREDIT_QUEUES } from '@sepehr/contracts';
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
import { CREDIT_STATUS, QUEUE_LABEL } from '../../../lib/credit';
import { serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'پرونده‌های اعتباری | پنل داخلی سپهر' };

const PAGE_SIZE = 20;

/**
 * Credit applications for the credit units (doc 10 §4, §8; task 3-8), filtered and paged
 * on the server: by state, and to one's own work in the completion, credit or committee
 * queue.
 */
export default async function CreditApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const status = CREDIT_APPLICATION_STATUSES.find((s) => s === one(params, 'status'));
  const queueCode = CREDIT_QUEUES.find((q) => q === one(params, 'queue'));
  const page = pageOf(params);
  const api = await serverApi();
  let result;
  let failure: unknown = null;
  try {
    result = await unwrap(
      api.GET('/api/v1/credit/applications', {
        params: {
          query: defined({ status, queueCode, page: String(page), pageSize: String(PAGE_SIZE) }),
        },
      }),
    );
  } catch (error) {
    failure = error;
  }

  return (
    <>
      <PageHeader title="پرونده‌های اعتباری" />
      <p className="flex gap-4">
        <Link href="/credit/groups" className="text-accent underline">
          گروه‌های پرونده
        </Link>
        <Link href="/credit/rules" className="text-accent underline">
          طرح‌ها و قواعد امتیاز
        </Link>
      </p>
      <FilterBar action="/credit" resetHref="/credit">
        <SelectField
          id="queue"
          name="queue"
          label="صف من"
          emptyLabel="همه پرونده‌ها"
          defaultValue={queueCode ?? ''}
          options={CREDIT_QUEUES.map((q) => ({ value: q, label: QUEUE_LABEL[q] }))}
        />
        <SelectField
          id="status"
          name="status"
          label="وضعیت"
          emptyLabel="همه وضعیت‌ها"
          defaultValue={status ?? ''}
          options={CREDIT_APPLICATION_STATUSES.map((s) => ({
            value: s,
            label: CREDIT_STATUS[s].label,
          }))}
        />
      </FilterBar>
      {failure || !result ? (
        <Notice tone="danger">{errorMessage(failure)}</Notice>
      ) : (
        <>
          <DataTable
            caption="پرونده‌های اعتباری"
            rows={result.items}
            rowKey={(a) => a.id}
            empty={<EmptyState title="پرونده‌ای با این فیلترها نیست." />}
            columns={[
              { key: 'created', header: 'ثبت', cell: (a) => showInstant(a.createdAt) },
              {
                key: 'plan',
                header: 'طرح',
                cell: (a) => `${a.planTitle} · ${faDigits(a.installmentCount)} قسط`,
              },
              { key: 'loan', header: 'وام', cell: (a) => toman(a.loanRial), numeric: true },
              {
                key: 'sla',
                header: 'مهلت بررسی',
                cell: (a) => (a.slaDueAt ? showInstant(a.slaDueAt) : '—'),
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
                header: 'پرونده',
                cell: (a) => (
                  <Link href={`/credit/${a.id}`} className="text-accent underline">
                    باز کردن
                  </Link>
                ),
              },
            ]}
          />
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            hrefFor={(p) => withParams('/credit', params, { page: p })}
          />
        </>
      )}
    </>
  );
}
