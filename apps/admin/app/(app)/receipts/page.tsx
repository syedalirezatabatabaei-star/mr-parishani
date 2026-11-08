import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  Notice,
  PageHeader,
  RECEIPT_KIND,
  rial,
  showDay,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../lib/server-api';
import { DecideReceipt, ViewReceipt } from './receipt-actions';

export const metadata: Metadata = { title: 'تأیید فیش‌ها | پنل داخلی سپهر' };

/**
 * Completion receipts waiting for finance (doc 12 §4; task 4-3), oldest first: what each
 * pays, its amount beside the amount owed, the Jalali day it was paid, the bank's tracking
 * number and its file. Approving posts through the ledger service; the page only asks.
 */
export default async function ReceiptsPage() {
  const api = await serverApi();
  let receipts;
  try {
    receipts = await unwrap(api.GET('/api/v1/receipts'));
  } catch (error) {
    return (
      <>
        <PageHeader title="تأیید فیش‌ها" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="تأیید فیش‌ها"
        description="هزینه تشکیل پرونده، کارمزد طرح و پیش‌پرداخت؛ همه به نام آرامش ثروت."
      />
      <DataTable
        caption="فیش‌های در انتظار تأیید مالی"
        rows={receipts}
        rowKey={(r) => r.id}
        empty={<EmptyState title="فیشی در انتظار تأیید نیست." />}
        columns={[
          { key: 'created', header: 'ارسال', cell: (r) => showInstant(r.createdAt) },
          { key: 'kind', header: 'بابت', cell: (r) => RECEIPT_KIND[r.kind] },
          { key: 'amount', header: 'مبلغ فیش', cell: (r) => rial(r.amountRial), numeric: true },
          {
            key: 'expected',
            header: 'مبلغ مورد انتظار',
            cell: (r) =>
              r.amountRial === r.expectedRial ? (
                rial(r.expectedRial)
              ) : (
                <span className="space-x-2">
                  <span>{rial(r.expectedRial)}</span>
                  <StatusBadge tone="danger">نابرابر</StatusBadge>
                </span>
              ),
            numeric: true,
          },
          { key: 'paid', header: 'روز پرداخت', cell: (r) => showDay(r.paidOn) },
          {
            key: 'reference',
            header: 'شماره پیگیری',
            cell: (r) => <bdi className="figures">{r.reference}</bdi>,
          },
          { key: 'file', header: 'فایل', cell: (r) => <ViewReceipt id={r.id} /> },
          { key: 'decide', header: 'تصمیم', cell: (r) => <DecideReceipt id={r.id} /> },
        ]}
      />
    </>
  );
}
