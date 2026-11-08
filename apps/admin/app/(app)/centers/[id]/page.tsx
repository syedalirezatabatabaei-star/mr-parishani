import { unwrap } from '@sepehr/api-client';
import {
  CENTER_STATUS,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstantDay,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cityNamer } from '../../../../lib/cities';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { CenterActions, DocumentStatus, RequestDecision } from './review-actions';

export const metadata: Metadata = { title: 'پرونده مرکز | پنل داخلی سپهر' };

const REQUEST_KIND = {
  activation: 'فعال‌سازی',
  reactivation: 'فعال‌سازی دوباره',
  bank_account: 'تغییر حساب بانکی',
} as const;
const REQUEST_STATUS = {
  proposed: { label: 'در انتظار نفر دوم', tone: 'warning' },
  approved: { label: 'تأییدشده', tone: 'success' },
  rejected: { label: 'ردشده', tone: 'danger' },
  withdrawn: { label: 'پس‌گرفته', tone: 'neutral' },
} as const;

/**
 * One center for its reviewer (doc 08 §3): the checklist with each document's status, the
 * branches, and what may happen next — back for fixing, an activation proposed by one
 * person and approved by another, a suspension or the end of the cooperation. The API
 * checks each step (rule 8) and who may take it (rule 12).
 */
export default async function CenterReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [api, session, cityName] = await Promise.all([serverApi(), getSession(), cityNamer()]);
  const [detail] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/catalog/centers/{id}', { params: { path: { id } } })),
  ]);
  if (detail.status === 'rejected') {
    return (
      <>
        <PageHeader title="پرونده مرکز" />
        <Notice tone="danger">{errorMessage(detail.reason)}</Notice>
      </>
    );
  }
  const center = detail.value;
  const status = CENTER_STATUS[center.status];
  const canReview = can(session, 'catalog.review_centers');
  const canSuspend = can(session, 'catalog.suspend_center');

  return (
    <>
      <PageHeader
        title={center.name}
        description={`${cityName(center.cityCode)} · ${center.personType === 'legal' ? 'حقوقی' : 'حقیقی'}`}
        actions={
          <Link href="/centers" className="text-accent underline">
            بازگشت به فهرست
          </Link>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        <span className="text-[length:var(--text-sm)] text-ink-muted">
          شناسه:{' '}
          <span dir="ltr" className="figures">
            {faDigits(`***${center.identifierLast4}`)}
          </span>
          {center.shebaLast4 && (
            <>
              {' '}
              · شبا:{' '}
              <span dir="ltr" className="figures">
                {faDigits(`IR***${center.shebaLast4}`)}
              </span>
            </>
          )}
          {center.firstActivatedAt && <> · فعال از {showInstantDay(center.firstActivatedAt)}</>}
        </span>
      </div>

      <section
        aria-labelledby="documents"
        className="space-y-2 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="documents" className="text-[length:var(--text-lg)] font-bold">
          مدارک
        </h2>
        <ul className="space-y-2">
          {center.documents.map((d) => (
            <li key={d.code} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {d.title}
                {d.note && (
                  <span className="text-[length:var(--text-sm)] text-ink-muted"> — {d.note}</span>
                )}
              </span>
              <DocumentStatus
                centerId={center.id}
                code={d.code}
                status={d.status}
                canEdit={canReview}
              />
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="branches"
        className="space-y-2 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="branches" className="text-[length:var(--text-lg)] font-bold">
          شعبه‌ها
        </h2>
        <ul className="space-y-1 text-[length:var(--text-sm)]">
          {center.branches.map((b) => (
            <li key={b.id}>
              {b.name}
              {b.isDefault ? ' (اصلی)' : ''}
              {b.address ? ` — ${b.address}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="requests"
        className="space-y-2 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="requests" className="text-[length:var(--text-lg)] font-bold">
          درخواست‌ها
        </h2>
        {center.requests.length === 0 ? (
          <p className="text-ink-muted">درخواستی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-3">
            {center.requests.map((r) => (
              <li key={r.id} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {REQUEST_KIND[r.kind]} — <span className="text-ink-muted">{r.reason}</span>
                  </span>
                  <StatusBadge tone={REQUEST_STATUS[r.status].tone}>
                    {REQUEST_STATUS[r.status].label}
                  </StatusBadge>
                </div>
                <RequestDecision requestId={r.id} open={r.status === 'proposed'} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <CenterActions
        centerId={center.id}
        status={center.status}
        canReview={canReview}
        canSuspend={canSuspend}
        hasOpenActivation={center.requests.some(
          (r) => r.status === 'proposed' && (r.kind === 'activation' || r.kind === 'reactivation'),
        )}
      />
    </>
  );
}
