import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  rial,
  showInstant,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../lib/server-api';
import { DecideFunding } from './funding-actions';

export const metadata: Metadata = { title: 'تأیید شارژ | پنل داخلی سپهر' };

/**
 * Funding requests waiting for finance (doc 12 §5; task 4-5's API, task 4-7's page), oldest
 * first: what funding will move (the loan and the down payment, exact rials) and in how many
 * installments. Approving charges the purse and makes the schedule in one transaction, by
 * the service; the page only asks. A request is never approved by who asked it.
 */
export default async function FundingPage() {
  const api = await serverApi();
  let requests;
  try {
    requests = await unwrap(
      api.GET('/api/v1/funding/requests', { params: { query: { status: 'requested' } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="تأیید شارژ" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="تأیید شارژ"
        description="شارژ کیف اعتبار پرونده‌های تکمیل‌شده؛ تأیید با شخصی جز درخواست‌دهنده."
      />
      <DataTable
        caption="درخواست‌های شارژ در انتظار تأیید"
        rows={requests}
        rowKey={(r) => r.id}
        empty={<EmptyState title="درخواست شارژی در انتظار تأیید نیست." />}
        columns={[
          { key: 'asked', header: 'درخواست', cell: (r) => showInstant(r.requestedAt) },
          {
            key: 'application',
            header: 'پرونده',
            cell: (r) => (
              <Link href={`/completion/${r.creditApplicationId}`} className="text-accent underline">
                مشاهده
              </Link>
            ),
          },
          { key: 'loan', header: 'وام', cell: (r) => rial(r.approvedAmountRial), numeric: true },
          {
            key: 'down',
            header: 'پیش‌پرداخت',
            cell: (r) => rial(r.downPaymentRial),
            numeric: true,
          },
          {
            key: 'count',
            header: 'اقساط',
            cell: (r) => faDigits(r.installmentCount),
            numeric: true,
          },
          {
            key: 'decide',
            header: 'تصمیم',
            cell: (r) => <DecideFunding id={r.id} mine={r.requestedByMe} />,
          },
        ]}
      />
    </>
  );
}
