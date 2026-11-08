import { unwrap } from '@sepehr/api-client';
import type { ProformaView } from '@sepehr/contracts';
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
import { PROFORMA_STATUS, REVISABLE } from '../../../../../lib/credit';
import { serverApi } from '../../../../../lib/server-api';
import { pricedServices } from '../priced-services';
import { type DraftLine, type PricedService } from '../proforma-editor';
import { ProformaActions } from './proforma-actions';

export const metadata: Metadata = {
  title: 'پیش‌فاکتور | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * One proforma (doc 10 §2): its lines, the tariff each was priced against, the patient's
 * answer. A draft is issued or discarded; an issued, disputed or expired one is corrected
 * only by a new version.
 */
export default async function PanelProformaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let proforma: ProformaView;
  try {
    proforma = await unwrap(api.GET('/api/v1/proformas/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="پیش‌فاکتور" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const status = PROFORMA_STATUS[proforma.status];
  const revisable = REVISABLE.includes(proforma.status);
  let services: PricedService[] = [];
  if (revisable) services = await pricedServices(proforma.workplaceId).catch(() => []);
  const lines: DraftLine[] = proforma.lines.map((l) => ({
    serviceCode: l.serviceCode,
    quantity: String(l.quantity),
    unitRial: l.unitRial,
    deviationReason: l.deviationReason ?? '',
    toothOrSite: l.toothOrSite ?? '',
    note: l.note ?? '',
  }));

  return (
    <>
      <PageHeader
        title={`پیش‌فاکتور نسخه ${faDigits(proforma.version)}`}
        description={[proforma.doctorName, proforma.placeName].filter(Boolean).join(' · ')}
      />
      <p>
        <Link
          href={`/panel/proformas?workplace=${proforma.workplaceId}`}
          className="text-accent underline"
        >
          بازگشت به فهرست پیش‌فاکتورها
        </Link>
      </p>
      <dl className="grid gap-2 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
        <div>
          <dt className="text-ink-muted">وضعیت</dt>
          <dd>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">جمع</dt>
          <dd className="figures font-bold">{toman(proforma.totalRial)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">صدور</dt>
          <dd className="figures">{proforma.issuedAt ? showInstant(proforma.issuedAt) : '—'}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">اعتبار تا</dt>
          <dd className="figures">
            {proforma.validUntil ? showInstant(proforma.validUntil) : '—'}
          </dd>
        </div>
        {proforma.patientResponseNote && (
          <div className="sm:col-span-2">
            <dt className="text-ink-muted">پاسخ بیمار</dt>
            <dd>{proforma.patientResponseNote}</dd>
          </div>
        )}
      </dl>
      <DataTable
        caption="ردیف‌ها"
        rows={proforma.lines}
        rowKey={(l) => String(l.lineNo)}
        empty={<p>ردیفی نیست.</p>}
        columns={[
          { key: 'service', header: 'خدمت', cell: (l) => l.serviceName },
          { key: 'site', header: 'دندان یا محل', cell: (l) => l.toothOrSite ?? '—' },
          { key: 'qty', header: 'تعداد', cell: (l) => faDigits(l.quantity), numeric: true },
          { key: 'unit', header: 'قیمت واحد', cell: (l) => toman(l.unitRial), numeric: true },
          {
            key: 'tariff',
            header: 'تعرفه',
            cell: (l) =>
              l.tariffMinRial === l.tariffMaxRial
                ? toman(l.tariffMinRial)
                : `${toman(l.tariffMinRial)} تا ${toman(l.tariffMaxRial)}`,
            numeric: true,
          },
          {
            key: 'deviation',
            header: 'خارج از تعرفه',
            cell: (l) => (l.deviates ? (l.deviationReason ?? 'دارد') : '—'),
          },
          { key: 'total', header: 'جمع ردیف', cell: (l) => toman(l.lineTotalRial), numeric: true },
        ]}
      />
      <ProformaActions
        id={proforma.id}
        status={proforma.status}
        revisable={revisable}
        services={services}
        lines={lines}
      />
    </>
  );
}
