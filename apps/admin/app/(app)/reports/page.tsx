import { unwrap } from '@sepehr/api-client';
import { EmptyState, errorMessage, faDigits, Notice, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'گزارش‌ها | پنل داخلی سپهر' };

/** The reports this account may run (task 7-7; doc 17 §2), each to its page. */
export default async function ReportsPage() {
  const api = await serverApi();
  let reports;
  try {
    reports = await unwrap(api.GET('/api/v1/reporting/reports'));
  } catch (error) {
    return (
      <>
        <PageHeader title="گزارش‌ها" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="گزارش‌ها"
        description="هر گزارش با فیلتر یکپارچه، فیلتر ذخیره‌شده، خروجی CSV و PDF و نسخه چاپی."
      />
      {reports.length === 0 ? (
        <EmptyState title="گزارشی برای نقش شما تعریف نشده است." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="فهرست گزارش‌ها">
          {reports.map((r) => (
            <li key={r.code} className="rounded-lg border border-border bg-surface p-4">
              <Link href={`/reports/${r.code}`} className="font-bold text-accent underline">
                {r.title}
              </Link>
              <p className="mt-1 text-[length:var(--text-sm)] text-ink-muted">
                {faDigits(r.columns.length)} ستون
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
