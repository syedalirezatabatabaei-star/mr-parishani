import { unwrap } from '@sepehr/api-client';
import { toJalali } from '@sepehr/contracts';
import { DataTable, faDigits, Notice, PageHeader, rial, showInstant } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'تخفیف‌های تشکیل پرونده | پنل داخلی سپهر' };

type SearchParams = Record<string, string | string[] | undefined>;
const MONTH = /^1[34]\d{2}-(0[1-9]|1[0-2])$/;
const percent = (bps: number) => `${faDigits((bps / 100).toFixed(bps % 100 === 0 ? 0 : 2))}٪`;

/**
 * ADR-048: the month's officer discounts on the origination fee (the annex's note 2): who,
 * which case, how much and why; for accounting and the CEO.
 */
export default async function OriginationDiscountsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [api, session, params] = await Promise.all([serverApi(), getSession(), searchParams]);
  if (!can(session, 'contract.read_origination_discounts')) {
    return (
      <>
        <PageHeader title="تخفیف‌های تشکیل پرونده" />
        <Notice tone="danger">اجازه این بخش را ندارید.</Notice>
      </>
    );
  }
  const now = toJalali(new Date());
  const current = `${String(now.year)}-${String(now.month).padStart(2, '0')}`;
  const raw = params['month'];
  const typed = (Array.isArray(raw) ? raw[0] : raw) ?? current;
  const month = MONTH.test(typed) ? typed : current;
  const rows = await unwrap(
    api.GET('/api/v1/origination-discounts', { params: { query: { month } } }),
  ).catch(() => []);
  return (
    <>
      <PageHeader
        title="تخفیف‌های تشکیل پرونده"
        description="تخفیف مسئولان تکمیل و باشگاه، با امضای خود و بی تأیید نفر دوم؛ گزارش ماهانه."
      />
      <form className="flex flex-wrap items-end gap-3" action="/origination-discounts">
        <label className="block space-y-1">
          <span className="block text-[length:var(--text-sm)] font-medium">ماه (سال-ماه)</span>
          <input
            name="month"
            defaultValue={month}
            dir="ltr"
            className="figures rounded border border-border px-2 py-1"
          />
        </label>
        <button type="submit" className="rounded border border-border px-3 py-1">
          نمایش
        </button>
      </form>
      <DataTable
        caption={`تخفیف‌های ${faDigits(month)} (${faDigits(rows.length)})`}
        rows={rows}
        rowKey={(r) => r.id}
        empty={<p>در این ماه تخفیفی ثبت نشده است.</p>}
        columns={[
          { key: 'at', header: 'ثبت', cell: (r) => showInstant(r.createdAt) },
          { key: 'who', header: 'مسئول', cell: (r) => r.grantedByName ?? '—' },
          {
            key: 'case',
            header: 'پرونده',
            cell: (r) => <Link href={`/completion/${r.creditApplicationId}`}>تکمیل پرونده</Link>,
          },
          { key: 'pct', header: 'درصد', cell: (r) => percent(r.discountBps), numeric: true },
          {
            key: 'amount',
            header: 'مبلغ کاهش',
            cell: (r) => (r.reductionRial === null ? 'هنوز قفل نشده' : rial(r.reductionRial)),
            numeric: true,
          },
          { key: 'reason', header: 'دلیل', cell: (r) => r.reason },
        ]}
      />
    </>
  );
}
