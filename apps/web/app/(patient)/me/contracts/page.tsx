import { unwrap } from '@sepehr/api-client';
import {
  CONTRACT_STATUS,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'قراردادهای من | سپهر سلامتی',
  robots: { index: false, follow: false },
};

const ROLE: Readonly<Record<'borrower' | 'guarantor', string>> = {
  borrower: 'وام‌گیرنده',
  guarantor: 'ضامن',
};

/**
 * The loan contracts the account is a party of (doc 12 §2): as the borrower or as a
 * guarantor, each with its state and whether this party has accepted it.
 */
export default async function MyContractsPage() {
  const api = await serverApi();
  let contracts;
  try {
    contracts = await unwrap(api.GET('/api/v1/me/contracts'));
  } catch (error) {
    return (
      <>
        <PageHeader title="قراردادهای من" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title="قراردادهای من" />
      {contracts.length === 0 ? (
        <EmptyState title="هنوز قراردادی برای شما آماده نشده است." />
      ) : (
        <ul className="space-y-3" aria-label="قراردادها">
          {contracts.map((c) => {
            const mine = c.parties.filter((p) => p.mine);
            const due = c.status === 'ready' && mine.some((p) => p.acceptedAt === null);
            return (
              <li key={c.id} className="space-y-2 rounded-lg border border-border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-bold">
                    قرارداد شماره <bdi className="figures">{faDigits(c.number)}</bdi>
                  </p>
                  <StatusBadge tone={CONTRACT_STATUS[c.status].tone}>
                    {CONTRACT_STATUS[c.status].label}
                  </StatusBadge>
                </div>
                <p className="text-[length:var(--text-sm)] text-ink-muted">
                  نقش شما: {mine.map((p) => ROLE[p.role]).join('، ')} · ساخت:{' '}
                  <span className="figures">{showInstant(c.createdAt)}</span>
                </p>
                <Link href={`/me/contracts/${c.id}`} className="text-accent underline">
                  {due ? 'مشاهده و پذیرش' : 'مشاهده'}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
