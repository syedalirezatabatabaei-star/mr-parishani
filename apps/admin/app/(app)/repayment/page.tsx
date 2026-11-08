import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  Notice,
  PageHeader,
  PAYMENT_STATE,
  showDay,
  showInstant,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { DecidePayment } from './payment-actions';

export const metadata: Metadata = { title: 'فیش اقساط | پنل داخلی سپهر' };

const CHANNEL: Readonly<Record<string, string>> = {
  staff: 'ثبت کارکنان',
  manual_receipt: 'فیش وام‌گیرنده',
  bank_statement: 'صورت‌حساب بانک یا وصول چک',
};

/**
 * Finance's queue of installment slips (task 6-2; doc 15 §2), oldest first: approved slips are
 * allocated to the oldest installments by the service; a slip like one already received is
 * approved only with an explicit decision. Under it, what is held in suspense, read only.
 */
export default async function RepaymentPaymentsPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let queue;
  let suspense;
  try {
    [queue, suspense] = await Promise.all([
      unwrap(
        api.GET('/api/v1/repayment/payments', {
          params: { query: { status: 'pending_approval' } },
        }),
      ),
      can(session, 'repayment.read')
        ? unwrap(api.GET('/api/v1/repayment/suspense'))
        : Promise.resolve([]),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="فیش اقساط" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="فیش اقساط"
        description="تأیید یا رد فیش‌های اقساط؛ تخصیص به قدیمی‌ترین قسط با خود سامانه است."
      />
      <nav aria-label="بخش‌های مالی اقساط" className="flex flex-wrap gap-4">
        <Link href="/bank-statements" className="text-accent underline">
          ورود صورت‌حساب بانک
        </Link>
        <Link href="/instruments" className="text-accent underline">
          چک‌ها: اجرا و استرداد
        </Link>
      </nav>
      <DataTable
        caption="فیش‌های در انتظار تأیید مالی"
        rows={queue}
        rowKey={(r) => r.id}
        empty={<EmptyState title="فیشی در انتظار تأیید نیست." />}
        columns={[
          { key: 'received', header: 'رسیدن', cell: (r) => showInstant(r.receivedAt) },
          { key: 'channel', header: 'از', cell: (r) => CHANNEL[r.channel] ?? r.channel },
          { key: 'amount', header: 'مبلغ', cell: (r) => toman(r.amountRial), numeric: true },
          { key: 'paid', header: 'روز واریز', cell: (r) => (r.paidOn ? showDay(r.paidOn) : '—') },
          {
            key: 'ref',
            header: 'شماره پیگیری',
            cell: (r) => <bdi className="figures">{r.bankRef ?? '—'}</bdi>,
          },
          { key: 'payer', header: 'واریزکننده', cell: (r) => r.payerName ?? '—' },
          {
            key: 'state',
            header: 'وضعیت',
            cell: (r) => (
              <span className="space-x-2">
                <StatusBadge tone={PAYMENT_STATE[r.status].tone}>
                  {PAYMENT_STATE[r.status].label}
                </StatusBadge>
                {r.suspectedDuplicateOf !== null && (
                  <StatusBadge tone="danger">شبیه فیش قبلی</StatusBadge>
                )}
              </span>
            ),
          },
          {
            key: 'decide',
            header: 'تصمیم',
            cell: (r) => <DecidePayment id={r.id} flagged={r.suspectedDuplicateOf !== null} />,
          },
        ]}
      />
      <DataTable
        caption="مانده در حساب معلق (فقط خواندنی؛ تعیین تکلیف دستی حسابداری)"
        rows={suspense}
        rowKey={(r) => r.scheduleId}
        empty={<EmptyState title="مانده‌ای در حساب معلق نیست." />}
        columns={[
          { key: 'all', header: 'کل', cell: (r) => toman(r.unallocatedRial), numeric: true },
          {
            key: 'surplus',
            header: 'اضافه‌پرداخت',
            cell: (r) => toman(r.surplusRial),
            numeric: true,
          },
          {
            key: 'rejected',
            header: 'رسیده و نپذیرفته',
            cell: (r) => toman(r.rejectedReceivedRial),
            numeric: true,
          },
          {
            key: 'pending',
            header: 'در انتظار تأیید',
            cell: (r) => toman(r.pendingRial),
            numeric: true,
          },
        ]}
      />
    </>
  );
}
