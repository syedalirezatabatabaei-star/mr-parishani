import { unwrap } from '@sepehr/api-client';
import { DataTable, errorMessage, faDigits, Notice, PageHeader, StatusBadge } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BATCH_STATUS, ROW_STATUS, SHEET_NAMES } from '../../../../lib/imports';
import { serverApi } from '../../../../lib/server-api';
import { BatchDecision } from './batch-decision';

export const metadata: Metadata = { title: 'دسته ورود از اکسل | پنل داخلی سپهر' };

/**
 * One batch (ADR-030): per sheet, how many rows are new, duplicates or wrong; the rows not
 * imported with why; then commit (the worker creates the centers, always as drafts) or
 * cancel while nothing was acted on. The report is a CSV of every row.
 */
export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const api = await serverApi();
  const [batch] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/catalog/imports/{id}', { params: { path: { id } } })),
  ]);
  if (batch.status === 'rejected') {
    return (
      <>
        <PageHeader title="دسته ورود از اکسل" />
        <Notice tone="danger">{errorMessage(batch.reason)}</Notice>
      </>
    );
  }
  const b = batch.value;
  const sheets = Object.entries(b.summary);
  return (
    <>
      <PageHeader
        title="دسته ورود از اکسل"
        actions={
          <Link href="/imports" className="text-accent underline">
            بازگشت به فهرست
          </Link>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={BATCH_STATUS[b.status].tone}>{BATCH_STATUS[b.status].label}</StatusBadge>
        <a
          href={`/api/v1/catalog/imports/${b.batchId}/report.csv`}
          download
          className="text-accent underline"
        >
          دریافت گزارش (CSV)
        </a>
      </div>
      <section
        aria-labelledby="summary"
        className="space-y-2 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="summary" className="text-[length:var(--text-lg)] font-bold">
          خلاصه
        </h2>
        {sheets.length === 0 ? (
          <p className="text-ink-muted">ردیفی در فایل نبود.</p>
        ) : (
          <ul className="space-y-1">
            {sheets.map(([sheet, counts]) => (
              <li key={sheet}>
                <span className="font-medium">{SHEET_NAMES[sheet] ?? sheet}:</span>{' '}
                {Object.entries(counts)
                  .map(([status, n]) => `${faDigits(n)} ${ROW_STATUS[status] ?? status}`)
                  .join('، ')}
              </li>
            ))}
          </ul>
        )}
      </section>
      {b.rejected.length > 0 && (
        <DataTable
          caption="ردیف‌هایی که وارد نمی‌شوند"
          rows={b.rejected}
          rowKey={(r) => `${r.sheet}-${String(r.rowNumber)}`}
          empty={null}
          columns={[
            { key: 'sheet', header: 'برگه', cell: (r) => SHEET_NAMES[r.sheet] ?? r.sheet },
            { key: 'row', header: 'ردیف', cell: (r) => faDigits(r.rowNumber), numeric: true },
            { key: 'status', header: 'وضعیت', cell: (r) => ROW_STATUS[r.status] ?? r.status },
            {
              key: 'problems',
              header: 'دلیل',
              cell: (r) =>
                r.problems.map((p) => (p.column ? `${p.column}: ${p.code}` : p.code)).join('، '),
            },
          ]}
        />
      )}
      {(b.status === 'previewed' || b.status === 'committed' || b.status === 'processed') && (
        <BatchDecision batchId={b.batchId} canCommit={b.status === 'previewed'} />
      )}
    </>
  );
}
