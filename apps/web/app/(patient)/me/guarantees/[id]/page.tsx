import { unwrap } from '@sepehr/api-client';
import {
  CONTRACT_STATUS,
  errorMessage,
  faDigits,
  Notice,
  OWN_INSTRUMENT_STATE,
  PageHeader,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../../lib/server-api';
import { ConsentForm, DocumentList } from '../../credit/credit-forms';

export const metadata: Metadata = {
  title: 'ضمانت | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * One commitment of a guarantor (doc 10 §5): its amount, the consent with a code, and the
 * guarantor's own documents. Nothing of the borrower is read here.
 */
export default async function MyGuaranteePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let guarantee;
  try {
    guarantee = await unwrap(api.GET('/api/v1/me/guarantees/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="ضمانت" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const applicationId = guarantee.creditApplicationId;
  const [documents, consent, contracts, instruments] = await Promise.allSettled([
    unwrap(
      api.GET('/api/v1/me/credit-applications/{id}/documents', {
        params: { path: { id: applicationId } },
      }),
    ),
    guarantee.consentGiven
      ? Promise.resolve(null)
      : unwrap(api.GET('/api/v1/me/credit/consent-text')),
    unwrap(api.GET('/api/v1/me/contracts')),
    // Task 6-9: the guarantor's own instruments only; nothing of the borrower's loan.
    unwrap(api.GET('/api/v1/me/instruments')),
  ]);
  // The guarantor accepts the contract too (doc 12 §2), on its own page.
  const contract =
    contracts.status === 'fulfilled'
      ? contracts.value.find((c) => c.creditApplicationId === applicationId)
      : undefined;
  const mine =
    documents.status === 'fulfilled'
      ? documents.value.people.find((p) => p.role === 'guarantor')
      : undefined;
  const open = guarantee.status !== 'withdrawn';
  const own =
    instruments.status === 'fulfilled'
      ? instruments.value.filter(
          (i) => i.creditApplicationId === applicationId && i.role === 'guarantor',
        )
      : [];

  return (
    <>
      <PageHeader title="ضمانت" />
      <div className="flex flex-wrap items-center gap-3">
        <span className="figures font-bold">تعهد شما: {toman(guarantee.commitmentRial)}</span>
        <StatusBadge tone={guarantee.consentGiven ? 'success' : 'warning'}>
          {guarantee.consentGiven ? 'رضایت داده‌اید' : 'در انتظار رضایت شما'}
        </StatusBadge>
      </div>
      {contract && (
        <p className="flex flex-wrap items-center gap-3">
          <span className="font-medium">قرارداد:</span>
          <StatusBadge tone={CONTRACT_STATUS[contract.status].tone}>
            {CONTRACT_STATUS[contract.status].label}
          </StatusBadge>
          <Link href={`/me/contracts/${contract.id}`} className="text-accent underline">
            مشاهده و پذیرش قرارداد
          </Link>
        </p>
      )}
      {open && !guarantee.consentGiven && consent.status === 'fulfilled' && consent.value && (
        <ConsentForm id={applicationId} role="guarantor" text={consent.value.text} />
      )}
      <section className="space-y-2" aria-labelledby="standing-title">
        <h2 id="standing-title" className="font-bold">
          وضعیت ضمانت شما
        </h2>
        <p>
          {guarantee.status === 'withdrawn'
            ? 'این ضمانت پایان یافته است.'
            : 'این ضمانت تا پایان بازپرداخت وام برقرار است.'}
        </p>
        {own.length === 0 ? (
          <p className="text-ink-muted">چک یا سفته‌ای از شما نزد سپهر ثبت نشده است.</p>
        ) : (
          <ul className="space-y-1" aria-label="چک و سفته شما">
            {own.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {i.kind === 'cheque' ? 'چک' : 'سفته'} به شماره پایانی{' '}
                  <bdi className="figures">{faDigits(i.numberLast4)}</bdi>،{' '}
                  <span className="figures">{toman(i.amountRial)}</span>
                </span>
                <StatusBadge tone={OWN_INSTRUMENT_STATE[i.status].tone}>
                  {OWN_INSTRUMENT_STATE[i.status].label}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </section>
      {mine && (
        <section className="space-y-2" aria-labelledby="documents-title">
          <h2 id="documents-title" className="font-bold">
            مدارک شما
          </h2>
          <DocumentList id={applicationId} role="guarantor" items={mine.items} canUpload={open} />
        </section>
      )}
    </>
  );
}
