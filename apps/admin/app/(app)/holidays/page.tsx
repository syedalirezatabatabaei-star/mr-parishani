import { unwrap } from '@sepehr/api-client';
import { jalaliMonthLength, JALALI_MAX_YEAR, JALALI_MIN_YEAR } from '@sepehr/contracts';
import {
  apiDay,
  DataTable,
  defined,
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  one,
  PageHeader,
  SelectField,
  showDay,
  StatusBadge,
  tehranToday,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { getCities } from '../../../lib/cities';
import { can, getSession, serverApi } from '../../../lib/server-api';
import {
  HolidayBatchDecision,
  HolidayBatchForm,
  HolidayForm,
  HolidayRemovalDecision,
  HolidayRemovalRequest,
} from './holiday-forms';

export const metadata: Metadata = { title: 'تعطیلات | پنل داخلی سپهر' };

/**
 * The holidays (doc 08 §5, ADR-021): one Jalali year at a time, national ones and, for a
 * chosen city, that city's own (Isfahan's local holidays, for the pilot). A holder of
 * config.manage_holidays asks to add or remove one with a reason, and a second person approves
 * (owner 1405/07/27 and 07/29): another holder, or the CEO's deputy who only decides
 * (config.approve_holidays, owner 1405/08/02); booking and working days read them at once.
 */
export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const today = tehranToday();
  const typedYear = Number(one(params, 'year'));
  const year =
    Number.isInteger(typedYear) && typedYear >= JALALI_MIN_YEAR && typedYear < JALALI_MAX_YEAR
      ? typedYear
      : today.year;
  const [api, session, cities] = await Promise.all([serverApi(), getSession(), getCities()]);
  const city = cities.find((c) => c.code === one(params, 'city'));
  const range = {
    from: apiDay({ year, month: 1, day: 1 }),
    to: apiDay({ year, month: 12, day: jalaliMonthLength(year, 12) }),
  };
  const [holidays, notices] = await Promise.allSettled([
    unwrap(
      api.GET('/api/v1/calendar/holidays', {
        params: { query: { ...range, ...defined({ cityCode: city?.code }) } },
      }),
    ),
    unwrap(api.GET('/api/v1/config/notices')),
  ]);
  const canManage = can(session, 'config.manage_holidays');
  // Owner 1405/08/02: the CEO's deputy (config.approve_holidays) sees and decides the pending
  // batches and removals, and asks for nothing.
  const canDecide = canManage || can(session, 'config.approve_holidays');
  // Plan 3 (ADR-043): the year's suggested official holidays, a preview; nothing is saved.
  const suggestions = canManage
    ? await unwrap(
        api.GET('/api/v1/calendar/holidays/suggestions', { params: { query: { year } } }),
      ).then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason }),
      )
    : null;
  // Owner 1405/07/24: batches waiting for a second person, each with its count now.
  const batches = canDecide
    ? await unwrap(api.GET('/api/v1/calendar/holidays/batches')).catch(() => null)
    : null;
  // Owner 1405/07/29: removals waiting for a second person.
  const removals = canDecide
    ? await unwrap(api.GET('/api/v1/calendar/holidays/removals')).catch(() => null)
    : null;
  const removing = new Set((removals ?? []).map((r) => r.holidayId));
  const nameOf = (code: string | null) =>
    code === null ? 'سراسری' : (cities.find((c) => c.code === code)?.name ?? code);

  return (
    <>
      <PageHeader title="تعطیلات" description={`سال ${faDigits(year)}`} />
      {notices.status === 'fulfilled' &&
        notices.value.map((n) => (
          <Notice key={n.id} tone="warning">
            {n.message}
          </Notice>
        ))}
      <FilterBar action="/holidays" resetHref="/holidays" label="فیلتر تعطیلات" submitLabel="نمایش">
        <SelectField
          id="year"
          name="year"
          label="سال"
          defaultValue={String(year)}
          options={[-1, 0, 1, 2].map((d) => ({
            value: String(today.year + d),
            label: faDigits(today.year + d),
          }))}
        />
        <SelectField
          id="city"
          name="city"
          label="شهر"
          emptyLabel="فقط سراسری"
          defaultValue={city?.code ?? ''}
          options={cities.map((c) => ({ value: c.code, label: c.name }))}
        />
      </FilterBar>
      {holidays.status === 'rejected' ? (
        <Notice tone="danger">{errorMessage(holidays.reason)}</Notice>
      ) : (
        <DataTable
          caption={`تعطیلات سال ${faDigits(year)}`}
          rows={holidays.value}
          rowKey={(h) => h.id}
          empty={<EmptyState title="تعطیلی‌ای برای این سال ثبت نشده است." />}
          columns={[
            { key: 'day', header: 'روز', cell: (h) => showDay(h.on, 'long') },
            { key: 'title', header: 'عنوان', cell: (h) => h.title },
            {
              key: 'scope',
              header: 'دامنه',
              cell: (h) => (
                <StatusBadge tone={h.cityCode ? 'info' : 'neutral'}>
                  {nameOf(h.cityCode)}
                </StatusBadge>
              ),
            },
            ...(canManage
              ? [
                  {
                    key: 'actions',
                    header: 'کار',
                    cell: (h: (typeof holidays.value)[number]) =>
                      removing.has(h.id) ? (
                        <StatusBadge tone="warning">در انتظار تأیید برداشتن</StatusBadge>
                      ) : (
                        <HolidayRemovalRequest
                          id={h.id}
                          label={`${showDay(h.on, 'long')} · ${h.title}`}
                        />
                      ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {suggestions && (
        <section
          aria-labelledby="suggested-holidays"
          className="space-y-3 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="suggested-holidays" className="text-[length:var(--text-lg)] font-bold">
            پیشنهاد تعطیلات رسمی سال {faDigits(year)}
          </h2>
          <Notice tone="warning">
            روزهای قمری <strong>تخمینی</strong> است و ممکن است یک روز با تقویم رسمی فرق کند. هر روز
            قمری را فقط پس از اعلام رسمی ثبت کنید. روزهای شمسی ثابت‌اند. تا ثبت نشود، هیچ روزی تعطیل
            نیست.
          </Notice>
          {!suggestions.ok ? (
            <Notice tone="danger">{errorMessage(suggestions.reason)}</Notice>
          ) : (
            <>
              {suggestions.value.contractsWithDueOnNewDays > 0 && (
                <Notice tone="info">
                  {faDigits(suggestions.value.contractsWithDueOnNewDays)} قرارداد شارژنشده سررسید
                  چاپ‌شده‌ای روی یکی از روزهای تازه دارد. اگر جابه‌جایی سررسید برای پرونده‌اش روشن
                  باشد، شارژ آن سررسید را به روز کاری بعد می‌برد؛ مبلغ‌ها عوض نمی‌شوند.
                </Notice>
              )}
              <DataTable
                caption={`پیشنهاد تعطیلات سال ${faDigits(year)}`}
                rows={suggestions.value.days}
                rowKey={(d) => d.on}
                empty={<EmptyState title="قاعده‌ای برای پیشنهاد نیست." />}
                columns={[
                  { key: 'day', header: 'روز', cell: (d) => showDay(d.on, 'long') },
                  { key: 'title', header: 'عنوان', cell: (d) => d.title },
                  {
                    key: 'kind',
                    header: 'نوع',
                    cell: (d) =>
                      d.estimated ? (
                        <StatusBadge tone="warning">قمری، تخمینی</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">شمسی، ثابت</StatusBadge>
                      ),
                  },
                  {
                    key: 'state',
                    header: 'وضعیت',
                    cell: (d) =>
                      d.existing ? (
                        <StatusBadge tone="success">ثبت‌شده</StatusBadge>
                      ) : (
                        <StatusBadge tone="info">تازه</StatusBadge>
                      ),
                  },
                ]}
              />
              <HolidayBatchForm
                year={year}
                days={suggestions.value.days
                  .filter((d) => !d.existing)
                  .map((d) => ({
                    on: d.jalali,
                    key: d.on,
                    label: showDay(d.on, 'long'),
                    title: d.title,
                    estimated: d.estimated,
                  }))}
              />
            </>
          )}
        </section>
      )}
      {batches && batches.length > 0 && (
        <section
          aria-labelledby="holiday-batches"
          className="space-y-3 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="holiday-batches" className="text-[length:var(--text-lg)] font-bold">
            درخواست‌های ذخیره دسته‌ای در انتظار تأیید
          </h2>
          {batches.map((b) => (
            <article key={b.id} className="space-y-2 rounded-md border border-border p-3">
              <p className="font-bold">
                سال {faDigits(b.year)} · {faDigits(b.days.length)} روز · {b.reason}
              </p>
              <ul className="list-inside list-disc">
                {b.days.map((d) => (
                  <li key={d.on}>
                    {showDay(d.on, 'long')} · {d.title}
                  </li>
                ))}
              </ul>
              <Notice tone={(b.affectedContractsNow ?? 0) > 0 ? 'warning' : 'info'}>
                قراردادهای شارژنشده با سررسید چاپ‌شده روی این روزها: اکنون{' '}
                {faDigits(b.affectedContractsNow ?? 0)} (هنگام درخواست{' '}
                {faDigits(b.affectedContractsAtRequest)}). با جابه‌جایی سررسید روشن، شارژ آن‌ها
                سررسید را به روز کاری بعد می‌برد؛ مبلغ‌ها عوض نمی‌شوند.
              </Notice>
              {b.requestedByMe ? (
                <StatusBadge tone="neutral">درخواست شما؛ نفر دیگری باید تأیید کند</StatusBadge>
              ) : (
                <HolidayBatchDecision id={b.id} />
              )}
            </article>
          ))}
        </section>
      )}
      {removals && removals.length > 0 && (
        <section
          aria-labelledby="holiday-removals"
          className="space-y-3 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="holiday-removals" className="text-[length:var(--text-lg)] font-bold">
            درخواست‌های برداشتن تعطیلی در انتظار تأیید
          </h2>
          {removals.map((r) => (
            <article key={r.id} className="space-y-2 rounded-md border border-border p-3">
              <p className="font-bold">
                {showDay(r.on, 'long')} · {r.title} · {nameOf(r.cityCode)}
              </p>
              <p>دلیل: {r.reason}</p>
              {r.cityCode === null && (
                <Notice tone={(r.affectedContractsNow ?? 0) > 0 ? 'warning' : 'info'}>
                  قراردادهای شارژنشده با سررسید چاپ‌شده روی این روز: اکنون{' '}
                  {faDigits(r.affectedContractsNow ?? 0)} (هنگام درخواست{' '}
                  {faDigits(r.affectedContractsAtRequest)}).
                </Notice>
              )}
              {r.requestedByMe ? (
                <StatusBadge tone="neutral">درخواست شما؛ نفر دیگری باید تأیید کند</StatusBadge>
              ) : (
                <HolidayRemovalDecision id={r.id} />
              )}
            </article>
          ))}
        </section>
      )}
      {canManage && (
        <HolidayForm today={today} cities={cities.map((c) => ({ value: c.code, label: c.name }))} />
      )}
    </>
  );
}
