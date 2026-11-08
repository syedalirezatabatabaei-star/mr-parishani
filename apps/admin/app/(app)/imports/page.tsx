import { unwrap } from '@sepehr/api-client';
import { BULK_IMPORT_BATCH_STATUSES } from '@sepehr/contracts';
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
  withParams,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BATCH_STATUS, totals } from '../../../lib/imports';
import { serverApi } from '../../../lib/server-api';
import { UploadForm } from './upload-form';

export const metadata: Metadata = { title: 'ورود از اکسل | پنل داخلی سپهر' };

/**
 * The bulk import of centers and doctors (doc 08 §12, ADR-030): the template, a file
 * uploaded for a preview, and the caller's own batches filtered and paged on the server.
 * Behind `catalog.bulk_import_enabled`: while it is off, the page says so.
 */
export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const status = BULK_IMPORT_BATCH_STATUSES.find((s) => s === one(params, 'status'));
  const api = await serverApi();
  const [list] = await Promise.allSettled([
    unwrap(
      api.GET('/api/v1/catalog/imports', {
        params: { query: defined({ status, page: String(pageOf(params)) }) },
      }),
    ),
  ]);
  return (
    <>
      <PageHeader
        title="ورود از اکسل"
        description="مراکز واردشده همیشه پیش‌نویس می‌مانند و فعال‌سازی‌شان تأیید دونفره می‌خواهد."
      />
      {list.status === 'rejected' ? (
        <Notice tone="danger">{errorMessage(list.reason)}</Notice>
      ) : (
        <>
          {list.value.enabled ? (
            <UploadForm />
          ) : (
            <Notice tone="info" title="ورود از اکسل هنوز فعال نشده است">
              تا روشن شدن آن، فایل تازه پذیرفته نمی‌شود؛ دسته‌های قبلی را همچنان می‌بینید.
            </Notice>
          )}
          <FilterBar action="/imports" resetHref="/imports" label="فیلتر دسته‌ها">
            <SelectField
              id="status"
              name="status"
              label="وضعیت"
              emptyLabel="همه وضعیت‌ها"
              defaultValue={status ?? ''}
              options={BULK_IMPORT_BATCH_STATUSES.map((s) => ({
                value: s,
                label: BATCH_STATUS[s].label,
              }))}
            />
          </FilterBar>
          <DataTable
            caption="دسته‌های ورود از اکسل"
            rows={list.value.items}
            rowKey={(b) => b.batchId}
            empty={<EmptyState title="دسته‌ای نیست." />}
            columns={[
              {
                key: 'created',
                header: 'بارگذاری',
                cell: (b) => (
                  <Link href={`/imports/${b.batchId}`} className="text-accent hover:underline">
                    <time dateTime={b.createdAt}>{showInstant(b.createdAt)}</time>
                  </Link>
                ),
              },
              {
                key: 'rows',
                header: 'ردیف‌ها',
                cell: (b) => {
                  const t = totals(b.summary);
                  return `${faDigits(t.all)} ردیف، ${faDigits(t.rejected)} ردشده`;
                },
              },
              {
                key: 'status',
                header: 'وضعیت',
                cell: (b) => (
                  <StatusBadge tone={BATCH_STATUS[b.status].tone}>
                    {BATCH_STATUS[b.status].label}
                  </StatusBadge>
                ),
              },
            ]}
          />
          <Pagination
            page={list.value.page}
            pageSize={list.value.pageSize}
            total={list.value.total}
            hrefFor={(p) => withParams('/imports', params, { page: p })}
          />
        </>
      )}
    </>
  );
}
