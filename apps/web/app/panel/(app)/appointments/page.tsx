import { unwrap } from '@sepehr/api-client';
import { addJalaliDays, APPOINTMENT_STATUSES, jalaliDaysBetween } from '@sepehr/contracts';
import {
  DataTable,
  DateFilter,
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  PageHeader,
  parseJalaliParam,
  SelectField,
  showInstantDay,
  showTime,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { APPOINTMENT_STATUS } from '../../../../lib/appointments';
import { chosenWorkplace, getWorkplaces, workplaceLabel } from '../../../../lib/panel';
import { apiDay, defined, one, tehranToday, type SearchParams } from '../../../../lib/params';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { StaffActions } from './staff-actions';

export const metadata: Metadata = {
  title: 'نوبت‌ها | پنل مرکز',
  robots: { index: false, follow: false },
};

/** The API takes at most 62 days at once (appointmentListQuerySchema). */
const MAX_DAYS = 61;

/**
 * A workplace's appointments over a range of days, filtered on the server (task 2-11):
 * the requests to approve or reject, the patients to receive with their check-in code, and
 * a no-show or a cancellation with its reason.
 */
export default async function PanelAppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const [workplaces, session] = await Promise.all([getWorkplaces(), getSession()]);
  const mayIssue = can(session, 'proforma.issue');
  const workplace = chosenWorkplace(workplaces, params);
  const today = tehranToday();
  let from = parseJalaliParam(params['from']) ?? today;
  let to = parseJalaliParam(params['to']) ?? addJalaliDays(today, 6);
  if (jalaliDaysBetween(from, to) < 0) [from, to] = [to, from];
  const clipped = jalaliDaysBetween(from, to) > MAX_DAYS;
  if (clipped) to = addJalaliDays(from, MAX_DAYS);
  const status = APPOINTMENT_STATUSES.find((s) => s === one(params, 'status'));

  if (!workplace) {
    return (
      <>
        <PageHeader title="نوبت‌ها" />
        <EmptyState title="محل کاری در دسترس شما نیست." />
      </>
    );
  }

  const api = await serverApi();
  const [pendingResult, listResult] = await Promise.allSettled([
    unwrap(
      api.GET('/api/v1/booking/workplaces/{id}/pending-approvals', {
        params: { path: { id: workplace.workplaceId } },
      }),
    ),
    unwrap(
      api.GET('/api/v1/booking/workplaces/{id}/appointments', {
        params: {
          path: { id: workplace.workplaceId },
          query: { from: apiDay(from), to: apiDay(to), ...defined({ status }) },
        },
      }),
    ),
  ]);
  const pending = pendingResult.status === 'fulfilled' ? pendingResult.value : null;
  const list = listResult.status === 'fulfilled' ? listResult.value : [];
  const failure: unknown = listResult.status === 'rejected' ? listResult.reason : null;

  return (
    <>
      <PageHeader
        title="نوبت‌ها"
        description={
          pending
            ? `حالت تأیید: ${pending.approvalMode === 'manual' ? 'دستی' : 'خودکار'}`
            : undefined
        }
      />
      {pending && pending.waitingForManualApproval > 0 && (
        <Notice tone="warning">
          {faDigits(pending.waitingForManualApproval)} درخواست منتظر تأیید شماست.
        </Notice>
      )}
      <FilterBar action="/panel/appointments" resetHref="/panel/appointments" label="فیلتر نوبت‌ها">
        <SelectField
          id="workplace"
          name="workplace"
          label="پزشک و محل"
          defaultValue={workplace.workplaceId}
          options={workplaces.map((w) => ({ value: w.workplaceId, label: workplaceLabel(w) }))}
        />
        <DateFilter
          mode="range"
          label="بازه روزها"
          names={{ from: 'from', to: 'to' }}
          today={today}
          defaultValue={{ from, to }}
          hint=""
        />
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
      </FilterBar>
      {clipped && <Notice tone="info">بازه به ۶۲ روز محدود شد.</Notice>}
      {failure ? (
        <Notice tone="danger">{errorMessage(failure)}</Notice>
      ) : (
        <DataTable
          caption={`نوبت‌های ${workplaceLabel(workplace)}`}
          rows={list}
          rowKey={(a) => a.id}
          empty={<EmptyState title="در این بازه نوبتی نیست." />}
          columns={[
            {
              key: 'day',
              header: 'روز',
              cell: (a) => (
                <time dateTime={a.startsAt}>{showInstantDay(a.startsAt, 'numeric')}</time>
              ),
            },
            { key: 'time', header: 'ساعت', cell: (a) => showTime(a.startsAt), numeric: true },
            { key: 'service', header: 'خدمت', cell: (a) => a.serviceName },
            {
              key: 'patient',
              header: 'بیمار',
              cell: (a) => (
                <span dir="ltr" className="figures">
                  {faDigits(a.patient.mobileMasked)}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'وضعیت',
              cell: (a) => (
                <StatusBadge tone={APPOINTMENT_STATUS[a.status].tone}>
                  {a.status === 'cancelled_by_patient'
                    ? 'لغو به‌دست بیمار'
                    : APPOINTMENT_STATUS[a.status].label}
                </StatusBadge>
              ),
            },
            {
              key: 'actions',
              header: 'کار',
              cell: (a) => (
                <div className="space-y-2">
                  <StaffActions id={a.id} status={a.status} />
                  {mayIssue && a.status === 'examined' && (
                    <Link
                      href={`/panel/proformas/new?appointment=${a.id}&workplace=${workplace.workplaceId}`}
                      className="text-accent underline"
                    >
                      صدور پیش‌فاکتور
                    </Link>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}
    </>
  );
}
