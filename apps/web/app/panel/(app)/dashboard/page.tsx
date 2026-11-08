import { unwrap } from '@sepehr/api-client';
import { addJalaliDays, toJalali } from '@sepehr/contracts';
import {
  BarChart,
  millionTomans,
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  StatTile,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { getWorkplaces } from '../../../../lib/panel';
import { apiDay, tehranToday } from '../../../../lib/params';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { byMonth, monthOfInstant } from './months';

export const metadata: Metadata = {
  title: 'داشبورد | پنل مرکز',
  robots: { index: false, follow: false },
};

/** Counted as booked: not cancelled, rejected or lapsed. */
const NOT_BOOKED = new Set(['cancelled', 'rejected', 'expired']);
/** The panel lists at most this many workplaces' appointments at once. */
const MAX_WORKPLACES = 10;

/**
 * The center's and the doctor's dashboard (task 7-5; doc 17 §3): appointments today and this
 * week over the workplaces one covers, requests waiting; the doctor's rank in their field and
 * what is owed to them in the coming months; a center's statements summed over its doctors.
 * Each part only for who may read it (the API decides; rule 12).
 */
export default async function PanelDashboardPage() {
  const [session, workplaces] = await Promise.all([getSession(), getWorkplaces()]);
  const own = can(session, 'settlement.read_own');
  const center = can(session, 'settlement.read_center_summary');
  const appointments = can(session, 'booking.read_appointments', 'booking.manage_appointments');
  const api = await serverApi();
  const today = tehranToday();
  const shown = appointments ? workplaces.slice(0, MAX_WORKPLACES) : [];
  let data;
  try {
    data = await Promise.all([
      Promise.all(
        shown.map((w) =>
          unwrap(
            api.GET('/api/v1/booking/workplaces/{id}/appointments', {
              params: {
                path: { id: w.workplaceId },
                query: { from: apiDay(today), to: apiDay(addJalaliDays(today, 6)) },
              },
            }),
          ),
        ),
      ),
      Promise.all(
        shown.map((w) =>
          unwrap(
            api.GET('/api/v1/booking/workplaces/{id}/pending-approvals', {
              params: { path: { id: w.workplaceId } },
            }),
          ),
        ),
      ),
      own ? unwrap(api.GET('/api/v1/reporting/dashboards/doctor')) : null,
      own ? unwrap(api.GET('/api/v1/settlement/panel/upcoming')) : [],
      center ? unwrap(api.GET('/api/v1/settlement/panel/center-summary')) : [],
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="داشبورد" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const [lists, pendings, rank, upcoming, sums] = data;
  const booked = lists.flat().filter((a) => !NOT_BOOKED.has(a.status));
  const todays = booked.filter((a) => apiDay(toJalali(new Date(a.startsAt))) === apiDay(today));
  const waiting = pendings.reduce((n, p) => n + p.waitingForManualApproval, 0);
  const owed = byMonth(
    upcoming,
    (u) => monthOfInstant(u.dueAt),
    (u) => u.amountRial,
  );
  const statements = byMonth(
    sums,
    (s) => ({ year: s.periodYear, month: s.periodMonth }),
    (s) => s.grossRial,
  );
  return (
    <>
      <PageHeader title="داشبورد" description="نوبت‌ها، رتبه، دریافتی‌ها و صورت‌وضعیت." />
      {appointments && (
        <dl className="grid gap-3 sm:grid-cols-3">
          <StatTile label="نوبت‌های امروز" value={faDigits(todays.length)} />
          <StatTile label="نوبت‌های هفت روز آینده" value={faDigits(booked.length)} />
          <StatTile label="درخواست منتظر تأیید" value={faDigits(waiting)} />
        </dl>
      )}
      {rank && (
        <DataTable
          caption="رتبه شما در فیلد درمان (بیماران تکمیل‌شده در ۹۰ روز اخیر)"
          rows={rank.ranks}
          rowKey={(r) => `${r.doctorNodeId}:${r.treatmentField}`}
          empty={<EmptyState title="در ۹۰ روز اخیر بیمار تکمیل‌شده‌ای ندارید." />}
          columns={[
            { key: 'field', header: 'فیلد درمان', cell: (r) => r.treatmentField },
            { key: 'patients', header: 'بیمار', cell: (r) => faDigits(r.patients), numeric: true },
            {
              key: 'rank',
              header: 'رتبه',
              cell: (r) => `${faDigits(r.rank)} از ${faDigits(r.of)}`,
              numeric: true,
            },
          ]}
        />
      )}
      {own && (
        <BarChart
          title="دریافتی‌های آینده"
          categoryHeader="ماه سررسید"
          categories={owed.map((m) => m.label)}
          series={[{ label: 'دریافتی', values: owed.map((m) => Number(m.rial)) }]}
          format={(n) => toman(String(Math.round(n)))}
          axis={millionTomans}
        />
      )}
      {center && (
        <BarChart
          title="صورت‌وضعیت پزشکان مرکز"
          categoryHeader="دوره"
          categories={statements.map((m) => m.label)}
          series={[{ label: 'جمع ناخالص', values: statements.map((m) => Number(m.rial)) }]}
          format={(n) => toman(String(Math.round(n)))}
          axis={millionTomans}
        />
      )}
    </>
  );
}
