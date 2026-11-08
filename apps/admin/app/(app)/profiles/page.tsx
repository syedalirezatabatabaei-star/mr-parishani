import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'بررسی پروفایل‌ها | پنل داخلی سپهر' };

/**
 * Profile versions waiting for the network specialist (doc 08 §10, ADR-029), oldest first;
 * the API gives only the reviewer's cities. Nothing is public before approval (rule of
 * doc 09 open item 8: no profile without an expert's review).
 */
export default async function ProfileQueuePage() {
  const api = await serverApi();
  const [queue] = await Promise.allSettled([unwrap(api.GET('/api/v1/catalog/profile-reviews'))]);
  return (
    <>
      <PageHeader
        title="بررسی پروفایل‌ها"
        description="نسخه‌های در انتظار انتشار، به ترتیب ارسال."
        actions={
          <Link href="/profiles/links" className={buttonClass('secondary')}>
            نشانی پروفایل‌ها برای وردپرس
          </Link>
        }
      />
      {queue.status === 'rejected' ? (
        <Notice tone="danger">{errorMessage(queue.reason)}</Notice>
      ) : (
        <DataTable
          caption="صف بررسی پروفایل‌ها"
          rows={queue.value}
          rowKey={(v) => v.versionId}
          empty={<EmptyState title="پروفایلی در انتظار بررسی نیست." />}
          columns={[
            {
              key: 'doctor',
              header: 'پزشک',
              cell: (v) => (
                <Link
                  href={`/profiles/${v.doctor.id}`}
                  className="font-medium text-accent hover:underline"
                >
                  {v.doctor.name}
                </Link>
              ),
            },
            { key: 'version', header: 'نسخه', cell: (v) => faDigits(v.versionNo), numeric: true },
            {
              key: 'slug',
              header: 'نشانی',
              cell: (v) => (
                <span dir="ltr" className="text-[length:var(--text-sm)]">
                  /doctors/{v.slug}
                </span>
              ),
            },
            {
              key: 'submitted',
              header: 'ارسال',
              cell: (v) => <time dateTime={v.submittedAt}>{showInstant(v.submittedAt)}</time>,
            },
          ]}
        />
      )}
    </>
  );
}
