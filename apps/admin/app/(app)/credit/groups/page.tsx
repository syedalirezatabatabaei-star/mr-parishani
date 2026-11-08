import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  Notice,
  one,
  PageHeader,
  StatusBadge,
  toman,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CREDIT_STATUS } from '../../../../lib/credit';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = { title: 'گروه‌های پرونده | پنل داخلی سپهر' };

const SHORTFALL: Readonly<Record<string, string>> = {
  none: 'بی‌کسری',
  small: 'کسری کم (نقدی)',
  large: 'کسری زیاد',
};

/**
 * The groups of applications that finance one treatment (doc 10 §7; task 3-7): two
 * borrowers over the cap, or a new loan for a large shortfall. Each member is scored and
 * decided on its own; here they are side by side. `?group=` shows one.
 */
export default async function CreditGroupsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const wanted = one(params, 'group');
  const api = await serverApi();
  let groups;
  try {
    groups = wanted
      ? [await unwrap(api.GET('/api/v1/credit/groups/{id}', { params: { path: { id: wanted } } }))]
      : await unwrap(api.GET('/api/v1/credit/groups'));
  } catch (error) {
    return (
      <>
        <PageHeader title="گروه‌های پرونده" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title="گروه‌های پرونده" />
      <p className="flex gap-4">
        <Link href="/credit" className="text-accent underline">
          پرونده‌های اعتباری
        </Link>
        {wanted && (
          <Link href="/credit/groups" className="text-accent underline">
            همه گروه‌ها
          </Link>
        )}
      </p>
      {groups.length === 0 ? (
        <EmptyState title="هنوز گروهی ساخته نشده است." />
      ) : (
        groups.map((g, n) => (
          <DataTable
            key={g.caseGroupId}
            caption={`گروه ${String(n + 1)}`}
            rows={g.members}
            rowKey={(m) => m.id}
            empty={<p>عضوی نیست.</p>}
            columns={[
              {
                key: 'borrower',
                header: 'وام‌گیرنده',
                cell: (m) => (m.borrowerIsPatient ? 'خود بیمار' : 'شخص دیگر'),
              },
              { key: 'share', header: 'سهم', cell: (m) => toman(m.shareRial), numeric: true },
              { key: 'loan', header: 'وام', cell: (m) => toman(m.loanRial), numeric: true },
              {
                key: 'approved',
                header: 'مصوب',
                cell: (m) => (m.approvedAmountRial ? toman(m.approvedAmountRial) : '—'),
                numeric: true,
              },
              {
                key: 'shortfall',
                header: 'کسری',
                cell: (m) => (m.shortfallKind ? (SHORTFALL[m.shortfallKind] ?? '—') : '—'),
              },
              {
                key: 'status',
                header: 'وضعیت',
                cell: (m) => (
                  <StatusBadge tone={CREDIT_STATUS[m.status].tone}>
                    {CREDIT_STATUS[m.status].label}
                  </StatusBadge>
                ),
              },
              {
                key: 'open',
                header: 'پرونده',
                cell: (m) => (
                  <Link href={`/credit/${m.id}`} className="text-accent underline">
                    باز کردن
                  </Link>
                ),
              },
            ]}
          />
        ))
      )}
    </>
  );
}
