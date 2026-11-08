import { unwrap } from '@sepehr/api-client';
import type { CenterDetail } from '@sepehr/contracts';
import {
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  PageHeader,
  SelectField,
  showInstantDay,
  StatusBadge,
  type StatusTone,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { CENTER_STATUS } from '../../../../lib/centers';
import { cityNamer } from '../../../../lib/cities';
import { one, type SearchParams } from '../../../../lib/params';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { BankAccountRequest, BranchForm } from './center-forms';

export const metadata: Metadata = {
  title: 'مرکز و شعبه‌ها | پنل مرکز',
  robots: { index: false, follow: false },
};

const REQUEST_KIND: Readonly<Record<CenterDetail['requests'][number]['kind'], string>> = {
  activation: 'فعال‌سازی',
  reactivation: 'فعال‌سازی دوباره',
  bank_account: 'تغییر حساب بانکی',
};
const REQUEST_STATUS: Readonly<
  Record<CenterDetail['requests'][number]['status'], { label: string; tone: StatusTone }>
> = {
  proposed: { label: 'در انتظار تأیید نفر دوم', tone: 'warning' },
  approved: { label: 'تأییدشده', tone: 'success' },
  rejected: { label: 'ردشده', tone: 'danger' },
  withdrawn: { label: 'پس‌گرفته', tone: 'neutral' },
};
const DOC_STATUS = {
  received: { label: 'دریافت‌شده', tone: 'info' },
  verified: { label: 'تأییدشده', tone: 'success' },
  incomplete: { label: 'ناقص', tone: 'danger' },
} as const;

/**
 * The center (doc 08 §3): its details, its checklist, its branches with how to reach them
 * (shown to patients), and the requests a second person decides (rule: activation and a
 * Sheba change are never one person's act; only the last four digits are shown, rule 27).
 */
export default async function PanelCenterPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const [session, cityName] = await Promise.all([getSession(), cityNamer()]);
  const api = await serverApi();
  const centers = await unwrap(api.GET('/api/v1/catalog/centers')).catch(() => []);
  const chosen = centers.find((c) => c.id === one(params, 'center')) ?? centers[0];
  if (!chosen) {
    return (
      <>
        <PageHeader title="مرکز و شعبه‌ها" />
        <EmptyState title="مرکزی در دسترس شما نیست." />
      </>
    );
  }
  const [detail] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/catalog/centers/{id}', { params: { path: { id: chosen.id } } })),
  ]);
  const canManage = can(session, 'catalog.manage_centers');

  return (
    <>
      <PageHeader title="مرکز و شعبه‌ها" description={chosen.name} />
      {centers.length > 1 && (
        <FilterBar action="/panel/center" label="انتخاب مرکز" submitLabel="نمایش">
          <SelectField
            id="center"
            name="center"
            label="مرکز"
            defaultValue={chosen.id}
            options={centers.map((c) => ({ value: c.id, label: c.name }))}
          />
        </FilterBar>
      )}
      {detail.status === 'rejected' ? (
        <Notice tone="danger">{errorMessage(detail.reason)}</Notice>
      ) : (
        <CenterDetails detail={detail.value} canManage={canManage} cityName={cityName} />
      )}
    </>
  );
}

function CenterDetails({
  detail,
  canManage,
  cityName,
}: {
  detail: CenterDetail;
  canManage: boolean;
  cityName: (code: string) => string;
}) {
  const status = CENTER_STATUS[detail.status];
  return (
    <div className="space-y-6">
      <section
        className="space-y-2 rounded-lg border border-border bg-surface p-4"
        aria-label="اطلاعات مرکز"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[length:var(--text-lg)] font-bold">{detail.name}</h2>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </div>
        <dl className="grid gap-2 text-[length:var(--text-sm)] sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">شهر</dt>
            <dd>{cityName(detail.cityCode)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">
              {detail.personType === 'legal' ? 'شناسه ملی' : 'کد ملی'}
            </dt>
            <dd>
              <span className="figures" dir="ltr">
                {faDigits(`***${detail.identifierLast4}`)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">حساب بانکی (شبا)</dt>
            <dd>
              <span className="figures" dir="ltr">
                {detail.shebaLast4 ? faDigits(`IR***${detail.shebaLast4}`) : '—'}
              </span>
            </dd>
          </div>
          {detail.firstActivatedAt && (
            <div>
              <dt className="text-ink-muted">فعال از</dt>
              <dd>{showInstantDay(detail.firstActivatedAt)}</dd>
            </div>
          )}
        </dl>
      </section>

      {detail.documents.length > 0 && (
        <section
          className="space-y-2 rounded-lg border border-border bg-surface p-4"
          aria-labelledby="docs"
        >
          <h2 id="docs" className="text-[length:var(--text-lg)] font-bold">
            مدارک
          </h2>
          <ul className="space-y-1">
            {detail.documents.map((d) => (
              <li key={d.code} className="flex flex-wrap items-center justify-between gap-2">
                <span>{d.title}</span>
                {d.status ? (
                  <StatusBadge tone={DOC_STATUS[d.status].tone}>
                    {DOC_STATUS[d.status].label}
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">ارسال‌نشده</StatusBadge>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="branches">
        <h2 id="branches" className="text-[length:var(--text-lg)] font-bold">
          شعبه‌ها
        </h2>
        {detail.branches.map((b) => (
          <BranchForm key={b.id} branch={b} canEdit={canManage} />
        ))}
      </section>

      <section
        className="space-y-3 rounded-lg border border-border bg-surface p-4"
        aria-labelledby="requests"
      >
        <h2 id="requests" className="text-[length:var(--text-lg)] font-bold">
          درخواست‌ها
        </h2>
        {detail.requests.length === 0 ? (
          <p className="text-ink-muted">درخواستی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {detail.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {REQUEST_KIND[r.kind]}
                  {r.shebaLast4 && (
                    <span className="figures" dir="ltr">
                      {' '}
                      {faDigits(`IR***${r.shebaLast4}`)}
                    </span>
                  )}
                  <span className="text-[length:var(--text-sm)] text-ink-muted"> — {r.reason}</span>
                </span>
                <StatusBadge tone={REQUEST_STATUS[r.status].tone}>
                  {REQUEST_STATUS[r.status].label}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
        {canManage && detail.status === 'active' && <BankAccountRequest centerId={detail.id} />}
      </section>
    </div>
  );
}
