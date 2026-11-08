import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  DISPUTE_STATUS,
  EmptyState,
  errorMessage,
  Notice,
  PageHeader,
  showInstantDay,
  STATEMENT_STATUS,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { getSession, serverApi } from '../../../../lib/server-api';
import { ITEM_KIND, monthName, monthOf } from './labels';
import { DisputeButton, PdfButton } from './settlement-actions';

export const metadata: Metadata = {
  title: 'تسویه | پنل مرکز',
  robots: { index: false, follow: false },
};

/** Tomans, a negative one said in words (rule 2). */
const money = (rial: string) =>
  rial.startsWith('-') ? `منفی ${toman(rial.slice(1))}` : toman(rial);

/**
 * The doctor's settlement (task 5-6; doc 06 §6): the current statement with its items, past
 * statements with their PDF, what is owed in the coming months (each item can be objected
 * to), what is held by a dispute; a center's sums over its doctors. Only one's own (the API
 * checks it, rule 12).
 */
export default async function SettlementPage() {
  const session = await getSession();
  const permissions = session?.access.permissions ?? [];
  const own = permissions.includes('settlement.read_own');
  const center = permissions.includes('settlement.read_center_summary');
  const api = await serverApi();
  let data;
  try {
    data = await Promise.all([
      own ? unwrap(api.GET('/api/v1/settlement/panel/statements')) : [],
      own ? unwrap(api.GET('/api/v1/settlement/panel/upcoming')) : [],
      own ? unwrap(api.GET('/api/v1/settlement/panel/held')) : [],
      center ? unwrap(api.GET('/api/v1/settlement/panel/center-summary')) : [],
      // Task 7-7: an objection is a financial complaint, on the topic configured for it.
      permissions.includes('ticket.open_center')
        ? unwrap(api.GET('/api/v1/panel/tickets/topics'))
        : [],
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="تسویه" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const [statements, upcoming, held, sums, topics] = data;
  const complaintTopic = topics.find((t) => t.financial)?.code ?? null;
  const current = statements[0];
  return (
    <>
      <PageHeader
        title="تسویه"
        description="صورت‌وضعیت ماهانه، دریافتی‌های ماه‌های آینده و اقلام معلق به‌دلیل اعتراض."
      />
      {own ? (
        <>
          <section aria-labelledby="current-title" className="space-y-3">
            <h2 id="current-title" className="text-[length:var(--text-lg)] font-bold">
              صورت‌وضعیت جاری
            </h2>
            {current ? (
              <>
                <p>
                  {monthName(current.periodYear, current.periodMonth)} ·{' '}
                  <StatusBadge tone={STATEMENT_STATUS[current.status].tone}>
                    {STATEMENT_STATUS[current.status].label}
                  </StatusBadge>
                </p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
                  {(
                    [
                      ['خدمات اعتباری', current.grossCreditServicesRial],
                      ['کارمزد اعتباری', current.creditFeesRial],
                      ['کارمزد نقدی', current.cashFeesRial],
                      ['مانده دوره قبل', current.carriedInRial],
                      ['قابل پرداخت', current.payableRial],
                      ['منتقل به دوره بعد', current.carriedOutRial],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd className="font-bold">{money(value)}</dd>
                    </div>
                  ))}
                </dl>
                <DataTable
                  caption="اقلام صورت‌وضعیت جاری"
                  rows={current.items}
                  rowKey={(i) => `${i.kind}-${i.itemId}`}
                  empty={<EmptyState title="قلمی در این صورت‌وضعیت نیست." />}
                  columns={[
                    { key: 'kind', header: 'نوع', cell: (i) => ITEM_KIND[i.kind] },
                    { key: 'day', header: 'روز', cell: (i) => showInstantDay(i.occurredAt) },
                    {
                      key: 'amount',
                      header: 'مبلغ',
                      cell: (i) => money(i.amountRial),
                      numeric: true,
                    },
                  ]}
                />
              </>
            ) : (
              <EmptyState title="هنوز صورت‌وضعیتی برای شما ساخته نشده است." />
            )}
          </section>

          <DataTable
            caption="تاریخچه صورت‌وضعیت‌ها"
            rows={statements}
            rowKey={(s) => s.id}
            empty={<EmptyState title="صورت‌وضعیتی نیست." />}
            columns={[
              { key: 'month', header: 'دوره', cell: (s) => monthName(s.periodYear, s.periodMonth) },
              {
                key: 'status',
                header: 'وضعیت',
                cell: (s) => (
                  <StatusBadge tone={STATEMENT_STATUS[s.status].tone}>
                    {STATEMENT_STATUS[s.status].label}
                  </StatusBadge>
                ),
              },
              {
                key: 'payable',
                header: 'قابل پرداخت',
                cell: (s) => money(s.payableRial),
                numeric: true,
              },
              {
                key: 'pdf',
                header: 'PDF',
                cell: (s) => (s.pdfReady ? <PdfButton id={s.id} /> : '—'),
              },
            ]}
          />

          <DataTable
            caption="دریافتی‌های آینده"
            rows={upcoming}
            rowKey={(i) => i.itemId}
            empty={<EmptyState title="قلمی در انتظار سررسید نیست." />}
            columns={[
              { key: 'kind', header: 'نوع', cell: (i) => ITEM_KIND[i.kind] },
              { key: 'day', header: 'روز خدمت', cell: (i) => showInstantDay(i.occurredAt) },
              { key: 'amount', header: 'مبلغ', cell: (i) => money(i.amountRial), numeric: true },
              {
                key: 'fee',
                header: 'کارمزد',
                cell: (i) => (i.kind === 'credit_service' ? money(i.feeRial) : '—'),
                numeric: true,
              },
              {
                key: 'due',
                header: 'سررسید',
                cell: (i) =>
                  i.status === 'due' ? 'در صورت‌وضعیت بعدی' : `صورت‌وضعیت ${monthOf(i.dueAt)}`,
              },
              {
                key: 'dispute',
                header: 'اعتراض',
                cell: (i) =>
                  complaintTopic ? (
                    <DisputeButton
                      subjectType={i.subjectType}
                      subjectId={i.itemId}
                      topicCode={complaintTopic}
                    />
                  ) : (
                    '—'
                  ),
              },
            ]}
          />

          <DataTable
            caption="اقلام معلق به‌دلیل اعتراض"
            rows={held}
            rowKey={(i) => i.itemId}
            empty={<EmptyState title="قلم معلقی نیست." />}
            columns={[
              { key: 'kind', header: 'نوع', cell: (i) => ITEM_KIND[i.kind] },
              { key: 'amount', header: 'مبلغ', cell: (i) => money(i.amountRial), numeric: true },
              {
                key: 'opened',
                header: 'روز اعتراض',
                cell: (i) => (i.openedAt ? showInstantDay(i.openedAt) : '—'),
              },
              {
                key: 'status',
                header: 'وضعیت پیگیری',
                cell: (i) =>
                  i.disputeStatus ? (
                    <StatusBadge tone={DISPUTE_STATUS[i.disputeStatus].tone}>
                      {DISPUTE_STATUS[i.disputeStatus].label}
                    </StatusBadge>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        </>
      ) : null}

      {center ? (
        <DataTable
          caption="مجموع پزشکان مرکز"
          rows={sums}
          rowKey={(r) => `${String(r.periodYear)}-${String(r.periodMonth)}-${r.doctorNodeId}`}
          empty={<EmptyState title="هنوز صورت‌وضعیتی برای پزشکان مرکز ساخته نشده است." />}
          columns={[
            { key: 'month', header: 'دوره', cell: (r) => monthName(r.periodYear, r.periodMonth) },
            { key: 'doctor', header: 'پزشک', cell: (r) => r.providerName },
            { key: 'gross', header: 'خدمات', cell: (r) => money(r.grossRial), numeric: true },
            { key: 'fees', header: 'کارمزدها', cell: (r) => money(r.feesRial), numeric: true },
            { key: 'paid', header: 'پرداخت‌شده', cell: (r) => money(r.paidRial), numeric: true },
            {
              key: 'status',
              header: 'وضعیت',
              cell: (r) => (
                <StatusBadge tone={STATEMENT_STATUS[r.statementStatus].tone}>
                  {STATEMENT_STATUS[r.statementStatus].label}
                </StatusBadge>
              ),
            },
          ]}
        />
      ) : null}
    </>
  );
}
