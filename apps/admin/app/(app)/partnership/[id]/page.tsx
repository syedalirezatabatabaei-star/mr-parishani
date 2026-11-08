import { unwrap } from '@sepehr/api-client';
import { PARTNERSHIP_DOCUMENT_NAMES, PLACE_KIND_NAMES } from '@sepehr/contracts';
import {
  DataTable,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cityNamer } from '../../../../lib/cities';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { PARTNERSHIP_EVENT, PARTNERSHIP_STATUS } from '../labels';
import { ApproveRequest, OpenDocument, RejectRequest, ReviewRequest } from './partnership-actions';

export const metadata: Metadata = { title: 'درخواست همکاری | پنل داخلی سپهر' };

/** One request: what was sent, its documents and history, and the next person's step. */
export default async function PartnershipRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [session, api] = await Promise.all([getSession(), serverApi()]);
  let r;
  try {
    r = await unwrap(
      api.GET('/api/v1/catalog/partnership-requests/{id}', { params: { path: { id } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="درخواست همکاری" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const [city, fields] = await Promise.all([
    cityNamer(),
    unwrap(api.GET('/api/v1/catalog/fields')).catch(() => []),
  ]);
  const fieldName = (code: string) => fields.find((f) => f.code === code)?.name ?? code;
  const me = session?.me.accountId;
  const mayReview = can(session, 'catalog.review_partnership') && r.status === 'pending';
  const mayApprove =
    can(session, 'catalog.approve_partnership') && r.status === 'reviewed' && r.reviewedBy !== me;
  const facts: [string, string][] = [
    ['نوع', PLACE_KIND_NAMES[r.placeKind]],
    ['شخص', r.personType === 'legal' ? 'حقوقی' : 'حقیقی'],
    ['شهر', city(r.cityCode)],
    ['رشته‌های درمان', r.treatmentFieldCodes.map(fieldName).join('، ')],
    ['نشانی', r.address],
    ['تلفن', r.phone ? faDigits(r.phone) : '—'],
    ['مسئول', `${r.managerName}${r.managerRole ? ` (${r.managerRole})` : ''}`],
    ['موبایل مسئول', `…${faDigits(r.mobileLastFour)} (تأییدشده با کد)`],
  ];
  return (
    <>
      <PageHeader
        title={`درخواست همکاری ${faDigits(r.number)}: ${r.centerName}`}
        description={
          <StatusBadge tone={PARTNERSHIP_STATUS[r.status].tone}>
            {PARTNERSHIP_STATUS[r.status].label}
          </StatusBadge>
        }
        actions={
          <Link href="/partnership" className="text-accent underline">
            همه درخواست‌ها
          </Link>
        }
      />
      {r.status === 'rejected' && r.rejectionReason && (
        <Notice tone="danger" title="دلیل رد">
          {r.rejectionReason}
        </Notice>
      )}
      {r.reviewedBy === me && r.status === 'reviewed' && (
        <Notice tone="info">تأیید اولیه با شما بود؛ تأیید نهایی با نفر دوم است.</Notice>
      )}
      <section
        aria-label="مشخصات درخواست"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {facts.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="shrink-0 text-ink-muted">{k}:</dt>
              <dd className="figures">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <DataTable
        caption="پزشکان درخواست"
        rows={r.doctors}
        rowKey={(d) => d.councilNumber}
        empty={null}
        columns={[
          { key: 'name', header: 'پزشک', cell: (d) => d.name },
          {
            key: 'council',
            header: 'نظام پزشکی',
            numeric: true,
            cell: (d) => faDigits(d.councilNumber),
          },
          { key: 'specialty', header: 'تخصص', cell: (d) => d.specialty ?? '—' },
        ]}
      />
      <section aria-label="مدارک" className="space-y-2">
        <h2 className="font-bold">مدارک (اسکن‌شده با ClamAV)</h2>
        <div className="flex flex-wrap gap-2">
          {r.documents.map((d) => (
            <OpenDocument
              key={d.id}
              requestId={r.id}
              documentId={d.id}
              label={PARTNERSHIP_DOCUMENT_NAMES[d.kind]}
            />
          ))}
        </div>
      </section>
      {mayReview && <ReviewRequest id={r.id} legal={r.personType === 'legal'} />}
      {mayApprove && <ApproveRequest id={r.id} />}
      {(mayReview || mayApprove) && <RejectRequest id={r.id} />}
      {r.centerId && (
        <p>
          <Link href={`/centers/${r.centerId}`} className="text-accent underline">
            پرونده مرکز (فعال‌سازی دونفره در «بررسی مراکز»)
          </Link>
        </p>
      )}
      <section aria-label="تاریخچه" className="space-y-2">
        <h2 className="font-bold">تاریخچه</h2>
        <ol className="space-y-1 text-[length:var(--text-sm)]">
          {r.events.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-2">
              <span className="figures text-ink-muted">{showInstant(e.createdAt)}</span>
              <span className="font-medium">{PARTNERSHIP_EVENT[e.action] ?? e.action}</span>
              {e.note && <span className="text-ink-muted">— {e.note}</span>}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
