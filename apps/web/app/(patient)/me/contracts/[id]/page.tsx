import { unwrap } from '@sepehr/api-client';
import {
  CONTRACT_STATUS,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { AcceptContract, ViewContract } from '../contract-forms';

import { serverApi } from '../../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'قرارداد | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * One loan contract for a party of it (doc 12 §2): its PDF through a signed link, and the
 * acceptance with a code for each role this account holds. The other parties are shown by
 * role only, never by name or mobile.
 */
export default async function MyContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let contract;
  try {
    contract = await unwrap(api.GET('/api/v1/me/contracts/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="قرارداد" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const status = CONTRACT_STATUS[contract.status];
  let guarantor = 0;
  const parties = contract.parties.map((p) => ({
    ...p,
    title: p.role === 'borrower' ? 'وام‌گیرنده' : `ضامن ${faDigits(++guarantor)}`,
  }));
  const due = parties.filter((p) => p.mine && p.acceptedAt === null);

  return (
    <>
      <PageHeader title="قرارداد وام" />
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-bold">
          شماره <bdi className="figures">{faDigits(contract.number)}</bdi>
        </span>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        {contract.sample && (
          <StatusBadge tone="danger">پیش‌نویس — در انتظار تأیید حقوقی</StatusBadge>
        )}
      </div>
      {contract.status === 'generating' && (
        <Notice tone="info">متن قرارداد در حال آماده‌سازی است. کمی بعد دوباره سر بزنید.</Notice>
      )}
      {(contract.status === 'ready' || contract.status === 'accepted') && (
        <ViewContract id={contract.id} />
      )}
      <section className="space-y-2" aria-labelledby="parties-title">
        <h2 id="parties-title" className="font-bold">
          پذیرش طرفین
        </h2>
        <ul className="space-y-1">
          {parties.map((p) => (
            <li key={`${p.role}-${p.guarantorId ?? ''}`} className="flex flex-wrap gap-2">
              <span>
                {p.title}
                {p.mine ? ' (شما)' : ''}:
              </span>
              {p.acceptedAt ? (
                <span className="figures">پذیرفت، {showInstant(p.acceptedAt)}</span>
              ) : (
                <span className="text-ink-muted">هنوز نپذیرفته</span>
              )}
            </li>
          ))}
        </ul>
      </section>
      {contract.status === 'ready' &&
        due.map((p) => <AcceptContract key={p.role} id={contract.id} role={p.role} />)}
    </>
  );
}
