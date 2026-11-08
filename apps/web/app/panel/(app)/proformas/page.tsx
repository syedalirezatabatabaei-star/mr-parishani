import { unwrap } from '@sepehr/api-client';
import { PROFORMA_STATUSES } from '@sepehr/contracts';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  PageHeader,
  Pagination,
  SelectField,
  showInstant,
  StatusBadge,
  toman,
  withParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PROFORMA_STATUS } from '../../../../lib/credit';
import { chosenWorkplace, getWorkplaces, workplaceLabel } from '../../../../lib/panel';
import { defined, one, pageOf, type SearchParams } from '../../../../lib/params';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'پیش‌فاکتورها | پنل مرکز',
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 20;

/**
 * A workplace's proformas (doc 10 §2; task 3-8), filtered and paged on the server: each
 * version, its total and where it stands with the patient. A new one starts from an
 * appointment of the patient (its referral), on the appointments page.
 */
export default async function PanelProformasPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const workplaces = await getWorkplaces();
  const workplace = chosenWorkplace(workplaces, params);
  if (!workplace) {
    return (
      <>
        <PageHeader title="پیش‌فاکتورها" />
        <EmptyState title="محل کاری در دسترس شما نیست." />
      </>
    );
  }
  const status = PROFORMA_STATUSES.find((s) => s === one(params, 'status'));
  const page = pageOf(params);
  const api = await serverApi();
  let result;
  let failure: unknown = null;
  try {
    result = await unwrap(
      api.GET('/api/v1/proformas/workplaces/{id}', {
        params: {
          path: { id: workplace.workplaceId },
          query: defined({ status, page: String(page), pageSize: String(PAGE_SIZE) }),
        },
      }),
    );
  } catch (error) {
    failure = error;
  }

  return (
    <>
      <PageHeader title="پیش‌فاکتورها" description={workplaceLabel(workplace)} />
      <FilterBar action="/panel/proformas" resetHref="/panel/proformas">
        {workplaces.length > 1 && (
          <SelectField
            id="workplace"
            name="workplace"
            label="پزشک و محل"
            defaultValue={workplace.workplaceId}
            options={workplaces.map((w) => ({ value: w.workplaceId, label: workplaceLabel(w) }))}
          />
        )}
        <SelectField
          id="status"
          name="status"
          label="وضعیت"
          emptyLabel="همه وضعیت‌ها"
          defaultValue={status ?? ''}
          options={PROFORMA_STATUSES.map((s) => ({ value: s, label: PROFORMA_STATUS[s].label }))}
        />
      </FilterBar>
      {failure || !result ? (
        <Notice tone="danger">{errorMessage(failure)}</Notice>
      ) : (
        <>
          <DataTable
            caption={`پیش‌فاکتورهای ${workplaceLabel(workplace)}`}
            rows={result.items}
            rowKey={(p) => p.id}
            empty={
              <EmptyState title="پیش‌فاکتوری با این فیلتر نیست.">
                <Link href="/panel/appointments" className="text-accent underline">
                  صدور پیش‌فاکتور از نوبت بیمار
                </Link>
              </EmptyState>
            }
            columns={[
              {
                key: 'issued',
                header: 'صدور',
                cell: (p) => (p.issuedAt ? showInstant(p.issuedAt) : '—'),
              },
              { key: 'version', header: 'نسخه', cell: (p) => faDigits(p.version), numeric: true },
              { key: 'total', header: 'جمع', cell: (p) => toman(p.totalRial), numeric: true },
              {
                key: 'deviation',
                header: 'خارج از تعرفه',
                cell: (p) => (p.lines.some((l) => l.deviates) ? 'دارد' : '—'),
              },
              {
                key: 'status',
                header: 'وضعیت',
                cell: (p) => (
                  <StatusBadge tone={PROFORMA_STATUS[p.status].tone}>
                    {PROFORMA_STATUS[p.status].label}
                  </StatusBadge>
                ),
              },
              {
                key: 'open',
                header: 'جزئیات',
                cell: (p) => (
                  <Link href={`/panel/proformas/${p.id}`} className="text-accent underline">
                    مشاهده
                  </Link>
                ),
              },
            ]}
          />
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            hrefFor={(p) => withParams('/panel/proformas', params, { page: p })}
          />
        </>
      )}
    </>
  );
}
