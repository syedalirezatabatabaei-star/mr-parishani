import { unwrap } from '@sepehr/api-client';
import {
  BarChart,
  millionTomans,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatTile,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'داشبورد مدیرعامل | پنل داخلی سپهر' };

/** Rials as whole tomans for the chart's axis and table (exact amounts are in the reports). */
const tomans = (rial: number) => toman(String(Math.round(rial)));

/**
 * The CEO's dashboard (task 7-5; doc 17 §3), read only: the tiles and the six months' trend of
 * what was charged and collected, every money figure the ledger's own sums (task 7-4), and how
 * fresh it is.
 */
export default async function CeoDashboardPage() {
  const api = await serverApi();
  let d;
  try {
    d = await unwrap(api.GET('/api/v1/reporting/dashboards/ceo'));
  } catch (error) {
    return (
      <>
        <PageHeader title="داشبورد مدیرعامل" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="داشبورد مدیرعامل"
        description={d.asOf ? `به‌روز تا ${showInstant(d.asOf)}` : 'هنوز به‌روزرسانی نشده است.'}
      />
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="پرونده‌های فعال" value={faDigits(d.activeCases)} />
        <StatTile label="شارژ این ماه" value={toman(d.chargedThisMonthRial)} />
        <StatTile label="مانده بدهی" value={toman(d.outstandingDebtRial)} />
        <StatTile
          label="نسبت معوق"
          value={d.overdueRatio === null ? '—' : `${faDigits(d.overdueRatio)}٪`}
          hint="مبلغی، ۳۰ روز و بیشتر"
        />
        <StatTile label="شکایات باز" value={faDigits(d.openComplaints)} />
      </dl>
      <BarChart
        title="شارژ و وصول شش ماه اخیر"
        categoryHeader="ماه"
        categories={d.trend.map((m) => m.month)}
        series={[
          { label: 'شارژشده', values: d.trend.map((m) => Number(m.chargedRial)) },
          { label: 'وصول‌شده', values: d.trend.map((m) => Number(m.collectedRial)) },
        ]}
        format={tomans}
        axis={millionTomans}
      />
    </>
  );
}
