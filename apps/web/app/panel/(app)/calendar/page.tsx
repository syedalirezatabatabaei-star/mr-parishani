import { unwrap } from '@sepehr/api-client';
import { addJalaliDays } from '@sepehr/contracts';
import { EmptyState, errorMessage, FilterBar, Notice, PageHeader, SelectField } from '@sepehr/ui';
import type { Metadata } from 'next';
import { chosenWorkplace, getWorkplaces, workplaceLabel } from '../../../../lib/panel';
import { apiDay, tehranToday, type SearchParams } from '../../../../lib/params';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import {
  ApprovalModeForm,
  ExceptionEditor,
  ScheduleEditor,
  SlotsCalendar,
} from './calendar-editors';

export const metadata: Metadata = {
  title: 'تقویم کاری | پنل مرکز',
  robots: { index: false, follow: false },
};

/** Free times are asked for these many days ahead (the API takes at most 62). */
const DAYS_AHEAD = 61;

/**
 * A workplace's working calendar (doc 08 §6, ADR-025): the free times in month, week and
 * day views; the weekly hours; the exceptions of single days (closed, extra hours, open
 * on a holiday); and whether requests need the center's approval.
 */
export default async function PanelCalendarPage({
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
        <PageHeader title="تقویم کاری" />
        <EmptyState title="محل کاری در دسترس شما نیست." />
      </>
    );
  }
  const api = await serverApi();
  const today = tehranToday();
  const range = { from: apiDay(today), to: apiDay(addJalaliDays(today, DAYS_AHEAD)) };
  const id = workplace.workplaceId;
  const [calendar, slots, holidays, services] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/booking/workplaces/{id}/calendar', { params: { path: { id } } })),
    unwrap(
      api.GET('/api/v1/booking/workplaces/{id}/slots', { params: { path: { id }, query: range } }),
    ),
    unwrap(
      api.GET('/api/v1/calendar/holidays', {
        params: { query: { ...range, cityCode: workplace.cityCode } },
      }),
    ),
    unwrap(api.GET('/api/v1/catalog/services')),
  ]);
  const canEdit = can(
    session,
    'booking.manage_own_calendar',
    'booking.manage_calendar_in_scope',
    'booking.manage_any_calendar',
  );
  const canSetMode = can(session, 'booking.manage_approval_mode');
  const serviceOptions =
    services.status === 'fulfilled'
      ? services.value.map((s) => ({ value: s.code, label: s.name }))
      : [{ value: 'visit', label: 'ویزیت' }];

  return (
    <>
      <PageHeader title="تقویم کاری" description={workplaceLabel(workplace)} />
      {workplaces.length > 1 && (
        <FilterBar action="/panel/calendar" label="انتخاب پزشک و محل" submitLabel="نمایش">
          <SelectField
            id="workplace"
            name="workplace"
            label="پزشک و محل"
            defaultValue={id}
            options={workplaces.map((w) => ({ value: w.workplaceId, label: workplaceLabel(w) }))}
          />
        </FilterBar>
      )}
      {calendar.status === 'rejected' ? (
        <Notice tone="danger">{errorMessage(calendar.reason)}</Notice>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr]">
          <section aria-labelledby="free-times" className="space-y-3">
            <h2 id="free-times" className="text-[length:var(--text-lg)] font-bold">
              زمان‌های آزاد
            </h2>
            <SlotsCalendar
              today={today}
              slots={slots.status === 'fulfilled' ? slots.value : []}
              holidays={
                holidays.status === 'fulfilled'
                  ? holidays.value.map((h) => ({ on: h.on, title: h.title }))
                  : []
              }
            />
          </section>
          <div className="space-y-8">
            <ApprovalModeForm
              workplaceId={id}
              mode={calendar.value.approvalMode.mode}
              source={calendar.value.approvalMode.source}
              canEdit={canSetMode}
            />
            <ScheduleEditor
              workplaceId={id}
              schedule={calendar.value.schedule}
              services={serviceOptions}
              canEdit={canEdit}
            />
            <ExceptionEditor
              workplaceId={id}
              exceptions={calendar.value.exceptions}
              services={serviceOptions}
              today={today}
              canEdit={canEdit}
            />
          </div>
        </div>
      )}
    </>
  );
}
