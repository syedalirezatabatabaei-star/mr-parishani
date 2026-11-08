import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PROFORMA_STATUS } from '../../../../../lib/credit';
import { serverApi } from '../../../../../lib/server-api';
import { PlanChooser } from './plan-chooser';
import { ProformaResponse } from './proforma-response';

export const metadata: Metadata = {
  title: 'پیش‌فاکتور | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * One proforma for the patient (doc 10 §2–§3): its lines and total; confirm or dispute it
 * while issued; once confirmed, the plans that can finance it, compared side by side with
 * their installments on Jalali dates, and the choice of one.
 */
export default async function MyProformaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let proforma;
  try {
    proforma = await unwrap(api.GET('/api/v1/me/proformas/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="پیش‌فاکتور" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const status = PROFORMA_STATUS[proforma.status];
  const confirmed = proforma.status === 'patient_confirmed';
  const [plans, applications] = confirmed
    ? await Promise.allSettled([
        unwrap(api.GET('/api/v1/me/proformas/{id}/plans', { params: { path: { id } } })),
        unwrap(api.GET('/api/v1/me/credit-applications')),
      ])
    : [null, null];
  const existing =
    applications?.status === 'fulfilled'
      ? applications.value.find(
          (a) => a.proformaId === proforma.id && a.status !== 'rejected' && a.status !== 'expired',
        )
      : undefined;

  return (
    <>
      <PageHeader
        title={`پیش‌فاکتور نسخه ${faDigits(proforma.version)}`}
        description={proforma.placeName ?? undefined}
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        <span className="figures font-bold">جمع: {toman(proforma.totalRial)}</span>
        {proforma.validUntil && proforma.status === 'issued' && (
          <span className="text-[length:var(--text-sm)] text-ink-muted">
            معتبر تا <span className="figures">{showInstant(proforma.validUntil)}</span>
          </span>
        )}
      </div>
      <DataTable
        caption="خدمات پیش‌فاکتور"
        rows={proforma.lines}
        rowKey={(l) => String(l.lineNo)}
        empty={<p>ردیفی نیست.</p>}
        columns={[
          { key: 'service', header: 'خدمت', cell: (l) => l.serviceName },
          { key: 'site', header: 'دندان یا محل', cell: (l) => l.toothOrSite ?? '—' },
          { key: 'qty', header: 'تعداد', cell: (l) => faDigits(l.quantity), numeric: true },
          { key: 'unit', header: 'قیمت واحد', cell: (l) => toman(l.unitRial), numeric: true },
          { key: 'total', header: 'جمع', cell: (l) => toman(l.lineTotalRial), numeric: true },
        ]}
      />
      {proforma.status === 'issued' && <ProformaResponse id={proforma.id} />}
      {proforma.status === 'disputed' && (
        <Notice tone="info">اعتراض شما ثبت شد؛ پزشک می‌تواند نسخه تازه صادر کند.</Notice>
      )}
      {confirmed &&
        (existing ? (
          <Notice tone="success">
            برای این پیش‌فاکتور درخواست اعتبار دارید.{' '}
            <Link href={`/me/credit/${existing.id}`} className="underline">
              پیگیری درخواست
            </Link>
          </Notice>
        ) : plans?.status === 'fulfilled' ? (
          <>
            {plans.value.plans.length === 0 ? (
              plans.value.unavailablePlans.length === 0 && (
                <Notice tone="info">برای این درمان فعلاً طرح اعتباری وجود ندارد.</Notice>
              )
            ) : (
              <PlanChooser proformaId={proforma.id} plans={plans.value.plans} />
            )}
            {/* ADR-050 amendment: a plan that fits the case but not this proforma; no figures. */}
            {plans.value.unavailablePlans.map((p) => (
              <Notice key={p.code} tone="info">
                {p.title}: این طرح برای این پیش‌فاکتور قابل ارائه نیست؛ با کارشناس تماس بگیرید.
              </Notice>
            ))}
          </>
        ) : (
          <Notice tone="danger">
            {errorMessage(plans?.status === 'rejected' ? plans.reason : null)}
          </Notice>
        ))}
    </>
  );
}
