import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  FilterBar,
  Notice,
  PageHeader,
  SelectField,
  showInstantDay,
  toman,
} from '@sepehr/ui';
import type { TariffViewBody } from '@sepehr/contracts';
import type { Metadata } from 'next';
import { chosenWorkplace, getWorkplaces, workplaceLabel } from '../../../../lib/panel';
import type { SearchParams } from '../../../../lib/params';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { NewPriceForm, ProposedTariffs, VersionActions } from './price-forms';

export const metadata: Metadata = {
  title: 'خدمات و تعرفه | پنل مرکز',
  robots: { index: false, follow: false },
};

type Version = NonNullable<TariffViewBody['current']>;

const priceOf = (v: Version | null) =>
  !v
    ? '—'
    : v.status === 'withdrawn'
      ? 'ارائه نمی‌شود'
      : v.isFree
        ? 'رایگان'
        : v.minAmountRial === v.maxAmountRial
          ? toman(v.minAmountRial ?? '0')
          : `${toman(v.minAmountRial ?? '0')} تا ${toman(v.maxAmountRial ?? '0')}`;

/**
 * A workplace's services and prices (doc 08 §4, ADR-024): each price in force and those to
 * come, a new price from now on (earlier bookings keep theirs, rule 16), a withdrawal, and
 * the prices an Excel import proposed for the center (task 2-9 decision 2).
 */
export default async function PanelServicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const [workplaces, session] = await Promise.all([getWorkplaces(), getSession()]);
  const workplace = chosenWorkplace(workplaces, params);
  if (!workplace) {
    return (
      <>
        <PageHeader title="خدمات و تعرفه" />
        <EmptyState title="محل کاری در دسترس شما نیست." />
      </>
    );
  }
  const api = await serverApi();
  const canManage = can(session, 'catalog.manage_tariffs');
  const [tariffs, services, proposed] = await Promise.allSettled([
    unwrap(
      api.GET('/api/v1/catalog/tariffs', {
        params: { query: { workplaceId: workplace.workplaceId } },
      }),
    ),
    unwrap(api.GET('/api/v1/catalog/services')),
    canManage && workplace.centerId
      ? unwrap(
          api.GET('/api/v1/catalog/centers/{id}/proposed-tariffs', {
            params: { path: { id: workplace.centerId } },
          }),
        )
      : Promise.resolve([]),
  ]);
  const serviceList = services.status === 'fulfilled' ? services.value : [];
  const nameOf = (code: string) => serviceList.find((s) => s.code === code)?.name ?? code;

  return (
    <>
      <PageHeader title="خدمات و تعرفه" description={workplaceLabel(workplace)} />
      {workplaces.length > 1 && (
        <FilterBar action="/panel/services" label="انتخاب پزشک و محل" submitLabel="نمایش">
          <SelectField
            id="workplace"
            name="workplace"
            label="پزشک و محل"
            defaultValue={workplace.workplaceId}
            options={workplaces.map((w) => ({ value: w.workplaceId, label: workplaceLabel(w) }))}
          />
        </FilterBar>
      )}
      {proposed.status === 'fulfilled' && proposed.value.length > 0 && workplace.centerId && (
        <ProposedTariffs
          centerId={workplace.centerId}
          rows={proposed.value.map((p) => ({
            rowId: p.rowId,
            serviceName: nameOf(p.serviceCode),
            owner: p.owner,
            price:
              p.pricing.kind === 'free'
                ? 'رایگان'
                : `${toman(p.pricing.minRial)} تا ${toman(p.pricing.maxRial)}`,
          }))}
        />
      )}
      {tariffs.status === 'rejected' ? (
        <Notice tone="danger">{errorMessage(tariffs.reason)}</Notice>
      ) : (
        <DataTable
          caption={`تعرفه‌های ${workplaceLabel(workplace)}`}
          rows={tariffs.value}
          rowKey={(t) => t.id}
          empty={<EmptyState title="هنوز برای این محل تعرفه‌ای ثبت نشده است." />}
          columns={[
            { key: 'service', header: 'خدمت', cell: (t) => nameOf(t.serviceCode) },
            { key: 'now', header: 'تعرفه فعلی', cell: (t) => priceOf(t.current), numeric: true },
            {
              key: 'next',
              header: 'تغییر بعدی',
              cell: (t) =>
                t.upcoming.length === 0 ? (
                  '—'
                ) : (
                  <ul className="space-y-1">
                    {t.upcoming.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center gap-2">
                        <span className="figures">
                          {priceOf(v)} از {showInstantDay(v.effectiveAt)}
                        </span>
                        {canManage && <VersionActions versionId={v.id} kind="cancel" />}
                      </li>
                    ))}
                  </ul>
                ),
            },
            {
              key: 'actions',
              header: 'کار',
              cell: (t) =>
                canManage && t.current?.status === 'offered' ? (
                  <VersionActions tariffId={t.id} kind="withdraw" />
                ) : null,
            },
          ]}
        />
      )}
      {canManage && (
        <NewPriceForm
          workplaceId={workplace.workplaceId}
          services={serviceList.map((s) => ({ value: s.code, label: s.name }))}
        />
      )}
    </>
  );
}
