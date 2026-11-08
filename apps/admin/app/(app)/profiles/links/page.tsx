import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstantDay,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';
import { CsvButton } from './csv-button';

export const metadata: Metadata = { title: 'نشانی پروفایل‌ها | پنل داخلی سپهر' };

/** The patient site's address (`PATIENT_WEB_ORIGIN`): where the public profiles live. */
const patientOrigin = () =>
  (process.env['PATIENT_WEB_ORIGIN'] ?? 'http://localhost:3001').replace(/\/+$/, '');

/**
 * Every published profile's address (task 8-3), for linking them by hand from the WordPress
 * site; whether search engines index each (published with a listed workplace). Nothing on the
 * WordPress site changes from here.
 */
export default async function ProfileLinksPage() {
  const api = await serverApi();
  let links;
  try {
    links = await unwrap(api.GET('/api/v1/catalog/profile-links'));
  } catch (error) {
    return (
      <>
        <PageHeader title="نشانی پروفایل‌ها" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const origin = patientOrigin();
  const rows = links.map((l) => ({ ...l, url: `${origin}/doctors/${l.slug}` }));
  return (
    <>
      <PageHeader
        title="نشانی پروفایل‌ها"
        description={`نشانی ${faDigits(rows.length)} پروفایل منتشرشده، برای لینک‌دهی از سایت وردپرس.`}
        actions={<CsvButton rows={rows} />}
      />
      <Link href="/profiles" className="text-accent underline">
        بازگشت به بررسی پروفایل‌ها
      </Link>
      <DataTable
        caption="پروفایل‌های منتشرشده"
        rows={rows}
        rowKey={(r) => r.slug}
        empty={<EmptyState title="پروفایل منتشرشده‌ای نیست." />}
        columns={[
          { key: 'name', header: 'نام پزشک', cell: (r) => r.name },
          {
            key: 'url',
            header: 'نشانی',
            cell: (r) => (
              // nosemgrep: react-href-var -- the address is the configured origin and a slug, never typed by a user
              <a href={r.url} dir="ltr" className="text-accent underline">
                {r.url}
              </a>
            ),
          },
          {
            key: 'indexable',
            header: 'موتور جست‌وجو',
            cell: (r) =>
              r.indexable ? (
                <StatusBadge tone="success">قابل نمایه</StatusBadge>
              ) : (
                <StatusBadge tone="neutral">بی محل کار فعال، noindex</StatusBadge>
              ),
          },
          {
            key: 'published',
            header: 'انتشار',
            cell: (r) => (r.lastModified ? showInstantDay(r.lastModified) : '—'),
          },
        ]}
      />
    </>
  );
}
