import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  DISPUTE_STATUS,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstantDay,
  showJalaliMonth,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = { title: 'گزارش‌های تسویه | پنل داخلی سپهر' };

/**
 * Accounting's settlement reports (task 5-7): every item held by a dispute, and doctors whose
 * statements carry a balance, flagged from the configured number of periods (doc 14 پ).
 */
export default async function SettlementReportsPage() {
  const api = await serverApi();
  let data;
  try {
    data = await Promise.all([
      unwrap(api.GET('/api/v1/settlement/reports/held')),
      unwrap(api.GET('/api/v1/settlement/reports/negative')),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="گزارش‌های تسویه" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const [held, negative] = data;
  return (
    <>
      <PageHeader
        title="گزارش‌های تسویه"
        description="اقلام معلق به‌دلیل اعتراض، و مانده منفی پزشکان."
      />
      <DataTable
        caption="اقلام معلق"
        rows={held}
        rowKey={(r) => r.itemId}
        empty={<EmptyState title="قلم معلقی نیست." />}
        columns={[
          { key: 'doctor', header: 'پزشک', cell: (r) => r.providerName || '—' },
          {
            key: 'kind',
            header: 'نوع',
            cell: (r) => (r.kind === 'credit_service' ? 'خدمت اعتباری' : 'کارمزد خدمت نقدی'),
          },
          { key: 'amount', header: 'مبلغ', cell: (r) => toman(r.amountRial), numeric: true },
          {
            key: 'opened',
            header: 'اعتراض',
            cell: (r) => (r.openedAt ? showInstantDay(r.openedAt) : '—'),
          },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (r) =>
              r.disputeStatus ? (
                <StatusBadge tone={DISPUTE_STATUS[r.disputeStatus].tone}>
                  {DISPUTE_STATUS[r.disputeStatus].label}
                </StatusBadge>
              ) : (
                '—'
              ),
          },
        ]}
      />
      <DataTable
        caption="مانده منفی"
        rows={negative}
        rowKey={(r) => r.doctorId}
        empty={<EmptyState title="پزشکی با مانده منفی نیست." />}
        columns={[
          { key: 'doctor', header: 'پزشک', cell: (r) => r.providerName || '—' },
          {
            key: 'month',
            header: 'آخرین دوره',
            cell: (r) => showJalaliMonth(r.periodYear, r.periodMonth),
          },
          {
            key: 'carried',
            header: 'مانده منتقل',
            cell: (r) => toman(r.carriedOutRial),
            numeric: true,
          },
          {
            key: 'periods',
            header: 'دوره‌های پیاپی',
            cell: (r) => faDigits(r.periods),
            numeric: true,
          },
          {
            key: 'alert',
            header: 'هشدار',
            cell: (r) => (r.alert ? <StatusBadge tone="danger">نیازمند پیگیری</StatusBadge> : '—'),
          },
        ]}
      />
    </>
  );
}
