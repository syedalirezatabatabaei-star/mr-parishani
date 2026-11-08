import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  PAYOUT_STATUS,
  showDay,
  showJalaliMonth,
  STATEMENT_STATUS,
  StatusBadge,
  tehranToday,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../../lib/server-api';
import { PayoutActions, StatementActions } from '../settlement-actions';

export const metadata: Metadata = { title: 'صورت‌وضعیت | پنل داخلی سپهر' };

const money = (rial: string) =>
  rial.startsWith('-') ? `منفی ${toman(rial.slice(1))}` : toman(rial);

const LINE: Readonly<Record<string, string>> = {
  credit_service: 'خدمت اعتباری',
  credit_fee: 'کارمزد خدمت اعتباری',
  cash_fee: 'کارمزد خدمت نقدی',
  carried_in: 'مانده دوره قبل',
  other_deduction: 'سایر کسورات',
  offset_payable: 'تهاتر (بدهی به پزشک)',
  offset_fee: 'تهاتر (کارمزد)',
  carried_out: 'منتقل به دوره بعد',
};

/** One statement (tasks 5-4, 5-5, 5-7): its parts, lines and payout orders, and the steps. */
export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let data;
  try {
    data = await Promise.all([
      unwrap(api.GET('/api/v1/settlement/statements/{id}', { params: { path: { id } } })),
      unwrap(api.GET('/api/v1/settlement/payouts', { params: { query: { statementId: id } } })),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="صورت‌وضعیت" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const [s, payouts] = data;
  const today = tehranToday();
  return (
    <>
      <PageHeader
        title={`صورت‌وضعیت ${showJalaliMonth(s.periodYear, s.periodMonth)}`}
        description="اجزا طبق سند ۰۶؛ هر مرحله پرداخت با تأیید شخص دوم."
      />
      <p>
        <StatusBadge tone={STATEMENT_STATUS[s.status].tone}>
          {STATEMENT_STATUS[s.status].label}
        </StatusBadge>
        {s.cancelRequestedAt ? ' · لغو درخواست شده و منتظر تأیید نفر دوم است.' : ''}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        {(
          [
            ['خدمات اعتباری', s.grossCreditServicesRial],
            ['کارمزد اعتباری', s.creditFeesRial],
            ['کارمزد نقدی', s.cashFeesRial],
            ['مانده دوره قبل', s.carriedInRial],
            ['سایر کسورات', s.otherDeductionsRial],
            ['قابل پرداخت', s.payableRial],
            ['منتقل به دوره بعد', s.carriedOutRial],
            ['تهاتر در دفتر کل', s.offsetRial],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="font-bold">{money(value)}</dd>
          </div>
        ))}
      </dl>
      <StatementActions id={s.id} status={s.status} />
      <DataTable
        caption="ردیف‌های صورت‌وضعیت"
        rows={s.lines}
        rowKey={(l) => `${l.lineType}-${l.refId}`}
        empty={<EmptyState title="ردیفی نیست." />}
        columns={[
          { key: 'type', header: 'نوع', cell: (l) => LINE[l.lineType] ?? l.lineType },
          { key: 'ref', header: 'مرجع', cell: (l) => <bdi dir="ltr">{l.refId}</bdi> },
          { key: 'amount', header: 'مبلغ', cell: (l) => money(l.amountRial), numeric: true },
        ]}
      />
      <DataTable
        caption="دستورهای پرداخت"
        rows={payouts}
        rowKey={(p) => p.id}
        empty={<EmptyState title="دستور پرداختی نیست." />}
        columns={[
          {
            key: 'account',
            header: 'حساب',
            cell: (p) => <bdi dir="ltr">****{faDigits(p.ibanLast4)}</bdi>,
          },
          { key: 'holder', header: 'صاحب حساب', cell: (p) => p.accountHolder ?? '—' },
          { key: 'amount', header: 'مبلغ', cell: (p) => money(p.amountRial), numeric: true },
          {
            key: 'tracking',
            header: 'کد رهگیری',
            cell: (p) =>
              p.bankTrackingRef ? (
                <>
                  <bdi dir="ltr">{p.bankTrackingRef}</bdi>
                  {p.paidOn ? ` · ${showDay(p.paidOn)}` : ''}
                  {p.trackingRecordedByMe ? ' · ثبت شما' : ''}
                </>
              ) : (
                '—'
              ),
          },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (p) => (
              <StatusBadge tone={PAYOUT_STATUS[p.status].tone}>
                {PAYOUT_STATUS[p.status].label}
              </StatusBadge>
            ),
          },
          {
            key: 'actions',
            header: 'کار',
            cell: (p) => <PayoutActions id={p.id} status={p.status} today={today} />,
          },
        ]}
      />
    </>
  );
}
