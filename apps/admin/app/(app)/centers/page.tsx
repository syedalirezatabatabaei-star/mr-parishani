import { unwrap } from '@sepehr/api-client';
import { CENTER_STATUSES } from '@sepehr/contracts';
import {
  CENTER_STATUS,
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  one,
  PageHeader,
  SelectField,
  StatusBadge,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cityNamer } from '../../../lib/cities';
import { can, getSession, serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'بررسی مراکز | پنل داخلی سپهر' };

/**
 * The centers of the reviewer's cities (doc 08 §3), filtered by status on the server; the
 * queue (under review) by default. Activation is proposed by one person and approved by
 * another (doc 08 §15 test 8).
 */
export default async function CentersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  // The review queue unless the reviewer chose otherwise; an empty choice is «all».
  const wanted = 'status' in params ? one(params, 'status') : 'under_review';
  const status = CENTER_STATUSES.find((s) => s === wanted);
  const [api, cityName, session] = await Promise.all([serverApi(), cityNamer(), getSession()]);
  const [centers] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/catalog/centers', { params: { query: status ? { status } : {} } })),
  ]);
  return (
    <>
      <PageHeader title="بررسی مراکز" description="مراکز شهرهای در دسترس شما." />
      {(can(session, 'catalog.manage_centers') || can(session, 'catalog.manage_doctors')) && (
        <p className="flex flex-wrap gap-4">
          {can(session, 'catalog.manage_centers') && (
            <Link href="/centers/new" className="text-accent underline">
              ثبت مرکز تازه
            </Link>
          )}
          {can(session, 'catalog.manage_doctors') && (
            <Link href="/doctors/new" className="text-accent underline">
              ثبت پزشک تازه
            </Link>
          )}
        </p>
      )}
      <FilterBar action="/centers" resetHref="/centers?status=" label="فیلتر مراکز">
        <SelectField
          id="status"
          name="status"
          label="وضعیت"
          emptyLabel="همه وضعیت‌ها"
          defaultValue={status ?? ''}
          options={CENTER_STATUSES.map((s) => ({ value: s, label: CENTER_STATUS[s].label }))}
        />
      </FilterBar>
      {centers.status === 'rejected' ? (
        <Notice tone="danger">{errorMessage(centers.reason)}</Notice>
      ) : (
        <DataTable
          caption="مراکز"
          rows={centers.value}
          rowKey={(c) => c.id}
          empty={<EmptyState title="مرکزی با این وضعیت نیست." />}
          columns={[
            {
              key: 'name',
              header: 'نام',
              cell: (c) => (
                <Link href={`/centers/${c.id}`} className="font-medium text-accent hover:underline">
                  {c.name}
                </Link>
              ),
            },
            { key: 'city', header: 'شهر', cell: (c) => cityName(c.cityCode) },
            {
              key: 'person',
              header: 'نوع',
              cell: (c) => (c.personType === 'legal' ? 'حقوقی' : 'حقیقی'),
            },
            {
              key: 'id',
              header: 'شناسه',
              cell: (c) => (
                <span dir="ltr" className="figures">
                  {faDigits(`***${c.identifierLast4}`)}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'وضعیت',
              cell: (c) => (
                <StatusBadge tone={CENTER_STATUS[c.status].tone}>
                  {CENTER_STATUS[c.status].label}
                </StatusBadge>
              ),
            },
          ]}
        />
      )}
    </>
  );
}
