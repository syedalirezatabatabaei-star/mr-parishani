import { unwrap } from '@sepehr/api-client';
import { APPOINTMENT_STATUSES } from '@sepehr/contracts';
import {
  DateFilter,
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  navLinkClass,
  Notice,
  PageHeader,
  Pagination,
  parseJalaliParam,
  SelectField,
  showInstant,
  StatusBadge,
  toman,
  withParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { APPOINTMENT_STATUS, patientMayCancel } from '../../../../lib/appointments';
import {
  apiDay,
  defined,
  one,
  pageOf,
  tehranToday,
  type SearchParams,
} from '../../../../lib/params';
import { serverApi } from '../../../../lib/server-api';
import { AppointmentActions } from './appointment-actions';

export const metadata: Metadata = {
  title: 'نوبت‌های من | سپهر سلامتی',
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 10;
const WHEN = [
  { value: 'upcoming', label: 'پیش رو' },
  { value: 'past', label: 'گذشته' },
  { value: '', label: 'همه' },
] as const;

/**
 * The patient's appointments (doc 08 §7), filtered and paged on the server: the URL holds
 * the filter (task 2-11), so the list can be bookmarked and works without JavaScript.
 */
export default async function MyAppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  // Upcoming first, unless the visitor chose otherwise (an empty `when` is «all»).
  const when = 'when' in params ? one(params, 'when') : 'upcoming';
  const status = one(params, 'status');
  const from = parseJalaliParam(params['from']);
  const to = parseJalaliParam(params['to']);
  const page = pageOf(params);

  const api = await serverApi();
  const whenQuery: 'upcoming' | 'past' | undefined =
    when === 'upcoming' || when === 'past' ? when : undefined;
  const statusQuery = APPOINTMENT_STATUSES.find((s) => s === status);
  let result;
  let failure: unknown = null;
  try {
    result = await unwrap(
      api.GET('/api/v1/booking/me/appointments', {
        params: {
          query: defined({
            when: whenQuery,
            status: statusQuery,
            from: from ? apiDay(from) : undefined,
            to: to ? apiDay(to) : undefined,
            page: String(page),
            pageSize: String(PAGE_SIZE),
          }),
        },
      }),
    );
  } catch (error) {
    failure = error;
  }

  const tabHref = (value: string) =>
    withParams('/me/appointments', params, { when: value, page: null });
  return (
    <>
      <PageHeader title="نوبت‌های من" />
      <nav aria-label="زمان نوبت‌ها">
        <ul className="flex gap-1">
          {WHEN.map((w) => {
            const current = (when ?? '') === w.value;
            return (
              <li key={w.value}>
                <Link
                  href={tabHref(w.value)}
                  aria-current={current ? 'page' : undefined}
                  className={navLinkClass(current)}
                >
                  {w.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <FilterBar action="/me/appointments" resetHref={`/me/appointments?when=${when ?? ''}`}>
        <input type="hidden" name="when" value={when ?? ''} />
        <SelectField
          id="status"
          name="status"
          label="وضعیت"
          emptyLabel="همه وضعیت‌ها"
          defaultValue={status ?? ''}
          options={APPOINTMENT_STATUSES.filter((s) => s !== 'held').map((s) => ({
            value: s,
            label: APPOINTMENT_STATUS[s].label,
          }))}
        />
        <DateFilter
          mode="range"
          label="بازه روزها"
          names={{ from: 'from', to: 'to' }}
          today={tehranToday()}
          defaultValue={from && to ? { from, to } : null}
          hint=""
        />
      </FilterBar>

      {failure || !result ? (
        <Notice tone="danger">{errorMessage(failure)}</Notice>
      ) : result.items.length === 0 ? (
        <EmptyState title="نوبتی با این فیلترها نیست.">
          <Link href="/search" className="text-accent underline">
            جست‌وجوی پزشک و گرفتن نوبت
          </Link>
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-3" aria-label="فهرست نوبت‌ها">
            {result.items.map((a) => {
              const status = APPOINTMENT_STATUS[a.status];
              return (
                <li key={a.id} className="space-y-2 rounded-lg border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <p className="font-bold">{a.doctor.name}</p>
                      <p className="text-[length:var(--text-sm)] text-ink-muted">
                        {[a.serviceName, a.placeName].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </div>
                  <p className="figures">
                    <time dateTime={a.startsAt}>{showInstant(a.startsAt)}</time>
                  </p>
                  <p className="text-[length:var(--text-sm)] text-ink-muted">
                    هزینه:{' '}
                    <span className="figures">
                      {a.price.isFree
                        ? 'رایگان'
                        : a.price.minAmountRial === a.price.maxAmountRial
                          ? toman(a.price.minAmountRial)
                          : `${toman(a.price.minAmountRial)} تا ${toman(a.price.maxAmountRial)}`}
                    </span>
                  </p>
                  {a.checkInCode && (
                    <p className="text-[length:var(--text-sm)]">
                      کد پذیرش در مرکز:{' '}
                      <span dir="ltr" className="figures font-bold tracking-widest">
                        {faDigits(a.checkInCode)}
                      </span>
                    </p>
                  )}
                  <AppointmentActions
                    id={a.id}
                    canCancel={patientMayCancel(a)}
                    canDispute={a.status === 'no_show'}
                  />
                </li>
              );
            })}
          </ul>
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            hrefFor={(p) => withParams('/me/appointments', params, { page: p })}
          />
        </>
      )}
    </>
  );
}
