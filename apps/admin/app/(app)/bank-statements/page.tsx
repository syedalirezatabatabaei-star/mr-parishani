import { unwrap } from '@sepehr/api-client';
import { BANK_MATCH_KINDS } from '@sepehr/contracts';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showDay,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../lib/server-api';
import { ReviewRow, StatementImporter } from './bank-statement-forms';

export const metadata: Metadata = { title: 'صورت‌حساب بانک | پنل داخلی سپهر' };

const MATCH: Readonly<
  Record<string, { label: string; tone: 'success' | 'info' | 'warning' | 'danger' }>
> = {
  exact: { label: 'تطبیق دقیق', tone: 'success' },
  probable: { label: 'تطبیق احتمالی', tone: 'info' },
  none: { label: 'واریز ناشناس', tone: 'warning' },
  invalid: { label: 'ردیف نامعتبر', tone: 'danger' },
};

/**
 * A bank statement (task 6-3; doc 15 §2): the file read through a column mapping and imported
 * once; each row suggested to a slip, exactly or probably; a cleared cheque's labelled «مربوط
 * به چک» (task 6-8); an unknown deposit looked at with a note. Nothing here posts or approves.
 */
export default async function BankStatementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const importId = typeof params['import'] === 'string' ? params['import'] : null;
  const askedKind = typeof params['kind'] === 'string' ? params['kind'] : undefined;
  const kind = (BANK_MATCH_KINDS as readonly string[]).includes(askedKind ?? '')
    ? (askedKind as (typeof BANK_MATCH_KINDS)[number])
    : undefined;
  let rows = null;
  let error: string | null = null;
  if (importId) {
    const api = await serverApi();
    try {
      rows = await unwrap(
        api.GET('/api/v1/repayment/bank-statements/{id}/rows', {
          params: { path: { id: importId }, query: kind ? { kind } : {} },
        }),
      );
    } catch (err) {
      error = errorMessage(err);
    }
  }
  return (
    <>
      <PageHeader
        title="صورت‌حساب بانک"
        description="خواندن فایل بانک با نگاشت ستون‌ها و پیشنهاد تطبیق با فیش‌ها؛ هیچ ثبت مالی ندارد."
      />
      <StatementImporter />
      {error && <Notice tone="danger">{error}</Notice>}
      {importId && rows && (
        <section className="space-y-3" aria-labelledby="rows-title">
          <h2 id="rows-title" className="font-bold">
            ردیف‌های این صورت‌حساب
          </h2>
          <nav aria-label="نوع تطبیق" className="flex flex-wrap gap-3">
            <Link href={`/bank-statements?import=${importId}`} className="text-accent underline">
              همه
            </Link>
            {BANK_MATCH_KINDS.map((k) => (
              <Link
                key={k}
                href={`/bank-statements?import=${importId}&kind=${k}`}
                className="text-accent underline"
                aria-current={k === kind ? 'page' : undefined}
              >
                {MATCH[k]?.label}
              </Link>
            ))}
          </nav>
          <DataTable
            caption="ردیف‌ها"
            rows={rows}
            rowKey={(r) => r.id}
            empty={<EmptyState title="ردیفی نیست." />}
            columns={[
              { key: 'n', header: 'ردیف', cell: (r) => faDigits(r.rowNo), numeric: true },
              { key: 'day', header: 'روز', cell: (r) => (r.paidOn ? showDay(r.paidOn) : '—') },
              {
                key: 'amount',
                header: 'مبلغ',
                cell: (r) => (r.amountRial ? toman(r.amountRial) : '—'),
                numeric: true,
              },
              {
                key: 'ref',
                header: 'شماره پیگیری',
                cell: (r) => <bdi className="figures">{r.bankRef ?? '—'}</bdi>,
              },
              {
                key: 'match',
                header: 'تطبیق',
                cell: (r) => (
                  <span className="flex flex-wrap gap-1">
                    <StatusBadge tone={MATCH[r.matchKind]?.tone ?? 'info'}>
                      {MATCH[r.matchKind]?.label}
                    </StatusBadge>
                    {r.relatedToCheque && <StatusBadge tone="info">مربوط به چک</StatusBadge>}
                  </span>
                ),
              },
              {
                key: 'review',
                header: 'بررسی',
                cell: (r) =>
                  r.reviewedAt ? (
                    <span>{r.reviewNote}</span>
                  ) : r.matchKind === 'none' ? (
                    <ReviewRow id={r.id} />
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        </section>
      )}
    </>
  );
}
