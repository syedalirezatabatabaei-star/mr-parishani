import { unwrap } from '@sepehr/api-client';
import { EmptyState, errorMessage, Notice, PageHeader, StatusBadge, toman } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'ضمانت‌های من | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * A guarantor's own commitments (doc 10 §5; doc 04 §4): the amount of each, and whether
 * they have consented; never the borrower's score, another guarantor or a reason.
 */
export default async function MyGuaranteesPage() {
  const api = await serverApi();
  let guarantees;
  try {
    guarantees = await unwrap(api.GET('/api/v1/me/guarantees'));
  } catch (error) {
    return (
      <>
        <PageHeader title="ضمانت‌های من" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title="ضمانت‌های من" />
      {guarantees.length === 0 ? (
        <EmptyState title="شما ضامن پرونده‌ای نیستید." />
      ) : (
        <ul className="space-y-3" aria-label="ضمانت‌ها">
          {guarantees.map((g) => (
            <li key={g.id} className="space-y-2 rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="figures font-bold">تعهد: {toman(g.commitmentRial)}</p>
                <StatusBadge tone={g.consentGiven ? 'success' : 'warning'}>
                  {g.consentGiven ? 'رضایت داده‌اید' : 'در انتظار رضایت شما'}
                </StatusBadge>
              </div>
              <Link href={`/me/guarantees/${g.id}`} className="text-accent underline">
                رضایت و مدارک
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
