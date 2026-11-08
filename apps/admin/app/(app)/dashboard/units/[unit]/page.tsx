import { unwrap } from '@sepehr/api-client';
import {
  BarChart,
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  jalaliOfDay,
  showInstant,
  StatTile,
} from '@sepehr/ui';
import { JALALI_MONTH_NAMES } from '@sepehr/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../../lib/server-api';
import { UNITS } from '../units';

/** A day as the axis shows it: its day and month (۱۶ مهر). */
function shortDay(day: string): string {
  const j = jalaliOfDay(day);
  return j ? `${faDigits(j.day)} ${JALALI_MONTH_NAMES[j.month - 1] ?? ''}` : day;
}

export const metadata: Metadata = { title: 'داشبورد واحد | پنل داخلی سپهر' };

/**
 * A unit's dashboard (task 7-5; doc 17 §3): its ticket queue, deadlines past or at risk, its
 * agents' open load and the tickets opened each of the last fourteen days. Only for who works
 * the unit, its managers and the read-only roles (the API decides).
 */
export default async function UnitDashboardPage({ params }: { params: Promise<{ unit: string }> }) {
  const { unit } = await params;
  const title = `داشبورد ${UNITS[unit] ?? unit}`;
  const api = await serverApi();
  let d;
  try {
    d = await unwrap(
      api.GET('/api/v1/reporting/dashboards/units/{unit}', { params: { path: { unit } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title={title} />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={title}
        description={d.asOf ? `بار کارشناسان به‌روز تا ${showInstant(d.asOf)}` : undefined}
      />
      <div className="flex flex-wrap gap-4">
        <Link href="/dashboard/units" className="text-accent underline">
          همه واحدها
        </Link>
        <Link href={`/tickets?unit=${unit}`} className="text-accent underline">
          صف تیکت این واحد
        </Link>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="تیکت باز" value={faDigits(d.open)} />
        <StatTile label="بی کارشناس" value={faDigits(d.unassigned)} />
        <StatTile label="گذشته از مهلت" value={faDigits(d.overdue)} />
        <StatTile
          label="در خطر"
          value={faDigits(d.atRisk)}
          hint={`مهلت در ${faDigits(Math.round(d.atRiskMinutes / 60))} ساعت آینده`}
        />
      </dl>
      <BarChart
        title="تیکت‌های ثبت‌شده در ۱۴ روز اخیر"
        categoryHeader="روز"
        categories={d.opened.map((o) => shortDay(o.day))}
        series={[{ label: 'تیکت', values: d.opened.map((o) => o.tickets) }]}
        format={(n) => faDigits(Math.round(n))}
        integer
      />
      <DataTable
        caption="بار باز کارشناسان"
        rows={d.agents}
        rowKey={(a) => `${a.queue}:${a.accountId}`}
        empty={<EmptyState title="کار بازی به کارشناسی سپرده نشده است." />}
        columns={[
          { key: 'queue', header: 'صف', cell: (a) => a.queue },
          { key: 'agent', header: 'کارشناس', cell: (a) => a.accountId.slice(0, 8) },
          { key: 'open', header: 'باز', cell: (a) => faDigits(a.open) },
        ]}
      />
    </>
  );
}
