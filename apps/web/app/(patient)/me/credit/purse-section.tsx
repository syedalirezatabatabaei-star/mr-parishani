import type { MyFundingView, MyServiceAuthorizationView } from '@sepehr/contracts';
import {
  DataTable,
  faDigits,
  rial,
  SERVICE_STATUS,
  showDay,
  showInstant,
  StatusBadge,
  toman,
  type StatusTone,
} from '@sepehr/ui';

/** An installment's state in words (doc 02 §5; derived by the repayment module). */
const INSTALLMENT_STATUS: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  scheduled: { label: 'آینده', tone: 'neutral' },
  due: { label: 'سررسید امروز', tone: 'warning' },
  overdue: { label: 'گذشته از سررسید', tone: 'danger' },
  partially_paid: { label: 'بخشی پرداخت‌شده', tone: 'warning' },
  paid: { label: 'پرداخت‌شده', tone: 'success' },
  // Task 4-8: taken to zero by a cancellation (a new revision of the schedule).
  cancelled: { label: 'لغوشده', tone: 'neutral' },
};

/**
 * The patient's or borrower's credit purse once funded (doc 13 4-7): named from
 * configuration (`wallet.purse_title`, «کیف اعتبار» by default; never the money-wallet phrase of doc 01), what is
 * usable now, what was used and where (never what the treatment was), and the installments,
 * Jalali, exact to the rial.
 */
export function PurseSection({
  funding,
  used,
}: {
  funding: MyFundingView;
  used: readonly MyServiceAuthorizationView[];
}) {
  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-surface p-4"
      aria-labelledby="purse-title"
    >
      <h2 id="purse-title" className="text-[length:var(--text-lg)] font-bold">
        {funding.purseTitle}
      </h2>
      <dl className="grid gap-2 sm:grid-cols-3">
        <div>
          <dt className="text-ink-muted">قابل استفاده</dt>
          <dd>
            <span className="figures font-bold">{rial(funding.availableRial)}</span>
            <br />
            <span className="figures text-ink-muted">{toman(funding.availableRial)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">وام و پیش‌پرداخت</dt>
          <dd className="figures">
            {rial(BigInt(funding.approvedAmountRial) + BigInt(funding.downPaymentRial))}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">شارژ</dt>
          <dd className="figures">{funding.fundedAt ? showInstant(funding.fundedAt) : '—'}</dd>
        </div>
      </dl>
      <DataTable
        caption="تاریخچه مصرف"
        rows={used}
        rowKey={(u) => u.id}
        empty={<p className="text-ink-muted">هنوز خدمتی از این اعتبار گرفته نشده است.</p>}
        columns={[
          { key: 'when', header: 'تاریخ', cell: (u) => showInstant(u.deliveredAt ?? u.issuedAt) },
          { key: 'center', header: 'مرکز', cell: (u) => u.centerName ?? '—' },
          { key: 'amount', header: 'مبلغ', cell: (u) => rial(u.amountRial), numeric: true },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (u) => (
              <StatusBadge tone={SERVICE_STATUS[u.status].tone}>
                {SERVICE_STATUS[u.status].label}
              </StatusBadge>
            ),
          },
        ]}
      />
      <DataTable
        caption="اقساط"
        rows={funding.installments}
        rowKey={(i) => String(i.index)}
        empty={<p className="text-ink-muted">برنامه اقساطی نیست.</p>}
        columns={[
          { key: 'index', header: 'قسط', cell: (i) => faDigits(i.index), numeric: true },
          { key: 'due', header: 'سررسید', cell: (i) => showDay(i.dueOn) },
          { key: 'amount', header: 'مبلغ', cell: (i) => rial(i.amountRial), numeric: true },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (i) => {
              const s = INSTALLMENT_STATUS[i.status] ?? { label: i.status, tone: 'neutral' };
              return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
            },
          },
        ]}
      />
    </section>
  );
}
