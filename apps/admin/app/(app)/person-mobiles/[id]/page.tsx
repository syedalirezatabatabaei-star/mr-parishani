import { unwrap } from '@sepehr/api-client';
import { errorMessage, faDigits, Notice, PageHeader, showInstant, StatusBadge } from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../../lib/server-api';
import { MobileDecision } from '../mobile-decision';
import { ADDED_VIA } from '../added-via';

export const metadata: Metadata = { title: 'تصمیم درباره موبایل | پنل داخلی سپهر' };

/**
 * One pending mobile's decision page (owner 1405/07/23): the whole number, which the API gives
 * only here and records each view of; the proposal, if any; and the two-person decision. The
 * first holder of `lead.approve_person_mobile` proposes with the evidence seen, a second, not
 * the proposer nor who added the mobile, approves; one refuses.
 */
export default async function PersonMobilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let m;
  try {
    m = await unwrap(api.GET('/api/v1/lead/person-mobiles/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="تصمیم درباره موبایل" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const proposal = m.proposalDetail;
  return (
    <>
      <PageHeader
        title="تصمیم درباره موبایل"
        description="شماره کامل فقط در این صفحه است و هر بار دیدنش ثبت می‌شود."
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-ink-muted">شماره</dt>
        <dd dir="ltr" className="text-start">
          {faDigits(`0${m.mobile}`)}
        </dd>
        <dt className="text-ink-muted">از راه</dt>
        <dd>{m.addedVia ? (ADDED_VIA[m.addedVia] ?? m.addedVia) : '—'}</dd>
        <dt className="text-ink-muted">افزوده در</dt>
        <dd>
          <time dateTime={m.addedAt}>{showInstant(m.addedAt)}</time>
        </dd>
        <dt className="text-ink-muted">رد خودکار در</dt>
        <dd>
          {m.expiresAt ? <time dateTime={m.expiresAt}>{showInstant(m.expiresAt)}</time> : '—'}
        </dd>
        <dt className="text-ink-muted">صاحب حساب</dt>
        <dd>
          {m.hasProvedMobile ? (
            <StatusBadge tone="info">می‌تواند خودش تأیید کند</StatusBadge>
          ) : (
            <StatusBadge tone="warning">فقط با مدرک</StatusBadge>
          )}
        </dd>
      </dl>
      <section aria-labelledby="proposal-title" className="mt-6 space-y-2">
        <h2 id="proposal-title" className="text-[length:var(--text-lg)] font-bold">
          پیشنهاد نفر اول
        </h2>
        {proposal ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt className="text-ink-muted">زمان</dt>
            <dd>
              <time dateTime={proposal.proposedAt}>{showInstant(proposal.proposedAt)}</time>
            </dd>
            <dt className="text-ink-muted">مدرک دیده‌شده</dt>
            <dd>{faDigits(proposal.evidence)}</dd>
            <dt className="text-ink-muted">دلیل</dt>
            <dd>{faDigits(proposal.reason)}</dd>
          </dl>
        ) : (
          <p>هنوز کسی تأیید این شماره را پیشنهاد نکرده است.</p>
        )}
      </section>
      <section aria-labelledby="decision-title" className="mt-6 space-y-2">
        <h2 id="decision-title" className="text-[length:var(--text-lg)] font-bold">
          تصمیم
        </h2>
        <MobileDecision id={m.id} proposed={proposal !== null} />
      </section>
    </>
  );
}
