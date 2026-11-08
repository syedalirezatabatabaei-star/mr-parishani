import { unwrap } from '@sepehr/api-client';
import { CONTENT_SLUG_TITLES, CONTENT_SLUGS } from '@sepehr/contracts';
import { DataTable, errorMessage, faDigits, Notice, PageHeader, showInstant } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';
import { ContentNav } from '../content-nav';

export const metadata: Metadata = { title: 'صفحه‌های متنی | پنل داخلی سپهر' };

/** The six text pages (owner 1405/08/10), each with the version in force and what waits. */
export default async function PagesIndex() {
  let all;
  try {
    all = await unwrap((await serverApi()).GET('/api/v1/config/content/pages'));
  } catch (error) {
    return (
      <>
        <PageHeader title="مدیریت محتوای پیشخوان" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const rows = CONTENT_SLUGS.map((slug) => {
    const versions = all.filter((v) => v.slug === slug);
    return {
      slug,
      inForce: versions.find((v) => v.status === 'approved') ?? null,
      pending: versions.filter((v) => v.status === 'pending').length,
    };
  });
  return (
    <>
      <PageHeader
        title="مدیریت محتوای پیشخوان"
        description="درباره، قوانین، حریم خصوصی، تماس، راهنما و پرسش‌های متداول؛ هر تغییر با تأیید نفر دوم."
      />
      <ContentNav current="/content/pages" />
      <DataTable
        caption="صفحه‌های متنی"
        rows={rows}
        rowKey={(r) => r.slug}
        empty={null}
        columns={[
          {
            key: 'page',
            header: 'صفحه',
            cell: (r) => (
              <Link href={`/content/pages/${r.slug}`} className="font-bold text-accent underline">
                {CONTENT_SLUG_TITLES[r.slug]}
              </Link>
            ),
          },
          {
            key: 'version',
            header: 'نسخه جاری',
            numeric: true,
            cell: (r) => (r.inForce ? faDigits(r.inForce.version) : '—'),
          },
          {
            key: 'at',
            header: 'تأیید',
            cell: (r) =>
              r.inForce?.decidedAt ? (
                <span className="figures">{showInstant(r.inForce.decidedAt)}</span>
              ) : (
                'هنوز منتشر نشده'
              ),
          },
          {
            key: 'pending',
            header: 'منتظر تأیید',
            numeric: true,
            cell: (r) => faDigits(r.pending),
          },
        ]}
      />
    </>
  );
}
