import { ApiError, unwrap } from '@sepehr/api-client';
import type { SearchResult } from '@sepehr/contracts';
import {
  buttonClass,
  DateFilter,
  EmptyState,
  FilterBar,
  Notice,
  PageHeader,
  Pagination,
  parseJalaliParam,
  SelectField,
  showInstantDay,
  showTime,
  TextField,
  toman,
  withParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { apiDay, defined, one, pageOf, tehranToday, type SearchParams } from '../../../lib/params';
import { errorMessage } from '@sepehr/ui';
import { getCities } from '../../../lib/cities';
import { serverApi } from '../../../lib/server-api';

export const metadata: Metadata = {
  title: 'جست‌وجوی پزشک و نوبت | سپهر سلامتی',
  description:
    'پزشکان و مراکز درمانی همکار سپهر سلامتی را بر اساس شهر، تخصص و زمان آزاد پیدا کنید.',
};

/** Where a result goes: its profile when published, else straight to booking. */
const doctorHref = (r: SearchResult) =>
  r.profileSlug ? `/doctors/${r.profileSlug}` : `/book/${r.workplaceId}`;

function PriceLine({ price }: { price: SearchResult['price'] }) {
  if (!price) return null;
  const amount = price.isFree
    ? 'رایگان'
    : price.minRial === price.maxRial
      ? toman(price.minRial)
      : `${toman(price.minRial)} تا ${toman(price.maxRial)}`;
  return (
    <p className="text-[length:var(--text-sm)] text-ink-muted">
      {price.serviceName}: <span className="figures text-ink">{amount}</span>
    </p>
  );
}

function ResultCard({
  result,
  cityName,
}: {
  result: SearchResult;
  cityName: (code: string) => string;
}) {
  return (
    <article className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-[length:var(--text-lg)] font-bold">
            <Link href={doctorHref(result)} className="hover:text-accent">
              {result.doctor.name}
            </Link>
          </h2>
          <p className="text-[length:var(--text-sm)] text-ink-muted">
            {[
              result.treatmentFields.map((f) => f.name).join('، '),
              result.placeName,
              cityName(result.cityCode),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {result.creditEnabled && (
          <span className="rounded-sm bg-highlight-soft px-2 py-1 text-[length:var(--text-xs)] font-medium text-on-highlight-soft">
            پرداخت با اعتبار سپهر
          </span>
        )}
      </div>
      <PriceLine price={result.price} />
      {result.slots.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[length:var(--text-sm)] font-medium">
            نزدیک‌ترین زمان‌ها ({showInstantDay(result.slots[0]?.startsAt ?? '')})
          </p>
          <ul className="flex flex-wrap gap-2">
            {result.slots.map((s) => (
              <li key={s.startsAt}>
                <Link
                  href={`/book/${result.workplaceId}?at=${encodeURIComponent(s.startsAt)}`}
                  className={buttonClass('secondary', 'figures min-h-9 px-3')}
                  aria-label={`نوبت ${showInstantDay(s.startsAt)} ساعت ${showTime(s.startsAt)}`}
                >
                  <time dateTime={s.startsAt}>{showTime(s.startsAt)}</time>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[length:var(--text-sm)] text-ink-muted">زمان آزاد نزدیکی ندارد.</p>
      )}
      <Link href={`/book/${result.workplaceId}`} className={buttonClass('primary')}>
        انتخاب زمان و نوبت
      </Link>
    </article>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const api = await serverApi();
  const today = tehranToday();
  const freeBy = parseJalaliParam(params['freeBy']);
  const page = pageOf(params);

  const [fields, services, cities] = await Promise.all([
    unwrap(api.GET('/api/v1/catalog/fields')).catch(() => []),
    unwrap(
      api.GET('/api/v1/catalog/services', {
        params: { query: defined({ fieldCode: one(params, 'field') }) },
      }),
    ).catch(() => []),
    getCities(),
  ]);
  const cityName = (code: string) => cities.find((c) => c.code === code)?.name ?? code;

  let result: Awaited<ReturnType<typeof search>> | null = null;
  let failure: unknown = null;
  async function search() {
    return unwrap(
      api.GET('/api/v1/search/doctors', {
        params: {
          query: defined({
            q: one(params, 'q'),
            cityCode: one(params, 'city'),
            fieldCode: one(params, 'field'),
            serviceCode: one(params, 'service'),
            credit: one(params, 'credit') === '1' ? ('true' as const) : undefined,
            freeBy: freeBy ? apiDay(freeBy) : undefined,
            page: String(page),
          }),
        },
      }),
    );
  }
  try {
    result = await search();
  } catch (error) {
    failure = error;
  }

  const disabled = failure instanceof ApiError && failure.code === 'feature_disabled';
  return (
    <>
      <PageHeader
        title="جست‌وجوی پزشک"
        description="ترتیب نتیجه‌ها ثابت و شفاف است: نزدیک‌ترین زمان آزاد، و با نوشتن نام، میزان شباهت."
      />
      <FilterBar action="/search" resetHref="/search" label="فیلتر جست‌وجو" submitLabel="جست‌وجو">
        <TextField
          id="q"
          name="q"
          type="search"
          label="نام پزشک، مرکز یا خدمت"
          defaultValue={one(params, 'q') ?? ''}
          className="min-w-56 grow"
        />
        <SelectField
          id="city"
          name="city"
          label="شهر"
          emptyLabel="همه شهرها"
          defaultValue={one(params, 'city') ?? ''}
          options={cities.filter((c) => c.active).map((c) => ({ value: c.code, label: c.name }))}
        />
        <SelectField
          id="field"
          name="field"
          label="تخصص"
          emptyLabel="همه تخصص‌ها"
          defaultValue={one(params, 'field') ?? ''}
          options={fields.map((f) => ({ value: f.code, label: f.name }))}
        />
        <SelectField
          id="service"
          name="service"
          label="خدمت"
          emptyLabel="ویزیت"
          defaultValue={one(params, 'service') ?? ''}
          options={services
            .filter((s) => s.kind !== 'visit')
            .map((s) => ({ value: s.code, label: s.name }))}
        />
        <DateFilter
          mode="single"
          name="freeBy"
          label="زمان آزاد تا"
          today={today}
          min={today}
          defaultValue={freeBy}
          hint=""
        />
        <label className="flex min-h-10 items-center gap-2 text-[length:var(--text-sm)]">
          <input
            type="checkbox"
            name="credit"
            value="1"
            defaultChecked={one(params, 'credit') === '1'}
            className="size-5 accent-[var(--color-accent)]"
          />
          فقط پرداخت با اعتبار سپهر
        </label>
      </FilterBar>

      {disabled ? (
        <Notice tone="info" title="جست‌وجو هنوز فعال نشده است">
          به‌زودی می‌توانید پزشکان را همین‌جا پیدا کنید.
        </Notice>
      ) : failure ? (
        <Notice tone="danger">{errorMessage(failure)}</Notice>
      ) : result && result.results.length === 0 ? (
        <EmptyState title="پزشکی با این فیلترها پیدا نشد.">
          فیلترها را کمتر کنید یا روز دیگری را برای زمان آزاد انتخاب کنید.
        </EmptyState>
      ) : result ? (
        <section aria-label="نتیجه‌ها" className="space-y-4">
          {result.featured && result.featured.results.length > 0 && (
            <div className="space-y-3 rounded-lg border-2 border-highlight p-3">
              <p className="font-bold">{result.featured.label}</p>
              {result.featured.results.map((r) => (
                <ResultCard key={r.workplaceId} result={r} cityName={cityName} />
              ))}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {result.results.map((r) => (
              <ResultCard key={r.workplaceId} result={r} cityName={cityName} />
            ))}
          </div>
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            hrefFor={(p) => withParams('/search', params, { page: p })}
          />
        </section>
      ) : null}
    </>
  );
}
