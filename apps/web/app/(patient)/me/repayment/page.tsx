import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  INSTALLMENT_STATE,
  OWN_INSTRUMENT_STATE,
  PAYMENT_STATE,
  Notice,
  PageHeader,
  showDay,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../../lib/server-api';
import { tehranToday } from '../../../../lib/params';
import { RepaymentReceiptForm } from './repayment-forms';

export const metadata: Metadata = {
  title: 'اقساط من | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * The borrower's own loans (task 6-9; doc 15 §2–3): each installment by its Jalali due day,
 * amount and state; what is left to pay; the slips sent and their outcome; sending a slip;
 * and the borrower's own cheques or notes by their last four characters only.
 */
export default async function MyRepaymentPage() {
  const api = await serverApi();
  let applications;
  let instruments;
  try {
    [applications, instruments] = await Promise.all([
      unwrap(api.GET('/api/v1/me/credit-applications')),
      unwrap(api.GET('/api/v1/me/instruments')),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="اقساط من" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const loans = (
    await Promise.all(
      applications.map(async (a) => {
        const schedules = await unwrap(
          api.GET('/api/v1/me/repayment/schedules', {
            params: { query: { creditApplicationId: a.id } },
          }),
        ).catch(() => []);
        return schedules.map((s) => ({ application: a, schedule: s }));
      }),
    )
  ).flat();
  const payments = await Promise.all(
    loans.map((l) =>
      unwrap(
        api.GET('/api/v1/me/repayment/schedules/{id}/payments', {
          params: { path: { id: l.schedule.id } },
        }),
      ).catch(() => []),
    ),
  );
  const today = tehranToday();

  return (
    <>
      <PageHeader title="اقساط من" description="سررسیدها، پرداخت‌ها و مانده بدهی وام‌های شما." />
      {loans.length === 0 && <EmptyState title="هنوز وامی با برنامه اقساط ندارید." />}
      {loans.map(({ application, schedule }, n) => {
        const mine = instruments.filter(
          (i) => i.creditApplicationId === application.id && i.role === 'borrower',
        );
        return (
          <section
            key={schedule.id}
            className="space-y-4 rounded-lg border border-border bg-surface p-4"
            aria-labelledby={`loan-${schedule.id}`}
          >
            <h2 id={`loan-${schedule.id}`} className="font-bold">
              {application.planTitle}، {faDigits(schedule.installments.length)} قسط
            </h2>
            <dl className="grid gap-2 sm:grid-cols-3">
              <div>
                <dt className="text-ink-muted">کل بدهی</dt>
                <dd className="figures font-bold">{toman(schedule.totalRial)}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">پرداخت‌شده</dt>
                <dd className="figures font-bold">{toman(schedule.paidRial)}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">مانده بدهی</dt>
                <dd className="figures font-bold">{toman(schedule.outstandingRial)}</dd>
              </div>
            </dl>
            <DataTable
              caption="اقساط"
              rows={schedule.installments.filter((i) => i.status !== 'cancelled')}
              rowKey={(i) => i.id}
              empty={<EmptyState title="قسطی نیست." />}
              columns={[
                { key: 'n', header: 'قسط', cell: (i) => faDigits(i.index), numeric: true },
                {
                  key: 'due',
                  header: 'سررسید',
                  // Owner 1405/07/24: a due day moved to a working day at funding says so.
                  cell: (i) =>
                    i.movedFrom === null ? (
                      showDay(i.dueOn)
                    ) : (
                      <span className="flex flex-col">
                        <span>{showDay(i.dueOn)}</span>
                        <span className="text-[length:var(--text-xs)] text-ink-subtle">
                          جابه‌جا شد از {showDay(i.movedFrom)} به‌دلیل تعطیلی
                        </span>
                      </span>
                    ),
                },
                { key: 'amount', header: 'مبلغ', cell: (i) => toman(i.amountRial), numeric: true },
                {
                  key: 'paid',
                  header: 'پرداخت‌شده',
                  cell: (i) => toman(i.paidRial),
                  numeric: true,
                },
                {
                  key: 'left',
                  header: 'مانده',
                  cell: (i) => toman(i.outstandingRial),
                  numeric: true,
                },
                {
                  key: 'state',
                  header: 'وضعیت',
                  cell: (i) => (
                    <StatusBadge tone={INSTALLMENT_STATE[i.status].tone}>
                      {INSTALLMENT_STATE[i.status].label}
                    </StatusBadge>
                  ),
                },
              ]}
            />
            <DataTable
              caption="فیش‌ها و پرداخت‌ها"
              rows={payments[n] ?? []}
              rowKey={(p) => p.id}
              empty={<EmptyState title="هنوز فیشی ثبت نشده است." />}
              columns={[
                {
                  key: 'day',
                  header: 'روز پرداخت',
                  cell: (p) => (p.paidOn ? showDay(p.paidOn) : '—'),
                },
                { key: 'amount', header: 'مبلغ', cell: (p) => toman(p.amountRial), numeric: true },
                {
                  key: 'ref',
                  header: 'شماره پیگیری',
                  cell: (p) => (
                    <bdi className="figures">{p.bankRef ? faDigits(p.bankRef) : '—'}</bdi>
                  ),
                },
                {
                  key: 'state',
                  header: 'وضعیت',
                  cell: (p) => (
                    <span className="space-y-1">
                      <StatusBadge tone={PAYMENT_STATE[p.status].tone}>
                        {PAYMENT_STATE[p.status].label}
                      </StatusBadge>
                      {p.rejectReason && (
                        <span className="block text-ink-muted">{p.rejectReason}</span>
                      )}
                    </span>
                  ),
                },
              ]}
            />
            {schedule.outstandingRial !== '0' && (
              <RepaymentReceiptForm scheduleId={schedule.id} today={today} />
            )}
            {mine.length > 0 && (
              <div className="space-y-2">
                <h3 className="font-bold">چک و سفته شما</h3>
                <ul className="space-y-1">
                  {mine.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center gap-2">
                      <span>
                        {i.kind === 'cheque' ? 'چک' : 'سفته'} به شماره پایانی{' '}
                        <bdi className="figures">{faDigits(i.numberLast4)}</bdi>،{' '}
                        <span className="figures">{toman(i.amountRial)}</span>
                      </span>
                      <StatusBadge tone={OWN_INSTRUMENT_STATE[i.status].tone}>
                        {OWN_INSTRUMENT_STATE[i.status].label}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
