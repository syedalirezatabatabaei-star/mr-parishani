import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  rial,
  showDay,
  showInstant,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { Decide } from './operation-actions';

export const metadata: Metadata = { title: 'عملیات ویژه | پنل داخلی سپهر' };

const PURSE_OPERATION: Readonly<Record<string, string>> = {
  cancel_unused: 'ابطال مانده مصرف‌نشده',
  reverse_cancel_unused: 'برگشت ابطال',
  change_doctor: 'تغییر پزشک',
  cancel_after_funding: 'انصراف پس از شارژ',
};
const REFUND_ACCOUNT: Readonly<Record<string, string>> = {
  fee: 'هزینه‌های پرونده',
  down_payment: 'پیش‌پرداخت',
};

function Queue({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3" aria-labelledby={id}>
      <h2 id={id} className="text-[length:var(--text-lg)] font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const failed = (error: unknown) => <Notice tone="danger">{errorMessage(error)}</Notice>;

/**
 * Task 4-8's special operations waiting for a second person (doc 12 §7): the purse's own
 * (cancelling what is unused, its reversal, a new doctor), a cancellation before funding,
 * a refund paid by bank, and a credit transfer or its revocation. Each is approved or
 * rejected with a reason, never by who asked it; the service decides whether it may be.
 */
export default async function SpecialOperationsPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const pending = { params: { query: { status: 'requested' as const } } };
  const [purseOps, cancellations, refunds, transfers, revokes, penalties] =
    await Promise.allSettled([
      can(session, 'wallet.approve_special_operation', 'wallet.approve_doctor_change')
        ? unwrap(api.GET('/api/v1/wallet/special-operations', pending))
        : Promise.resolve(null),
      can(session, 'credit.approve_cancellation')
        ? unwrap(api.GET('/api/v1/credit/cancellations', pending))
        : Promise.resolve(null),
      can(session, 'contract.approve_refund_payment')
        ? unwrap(api.GET('/api/v1/refund-payments', pending))
        : Promise.resolve(null),
      can(session, 'wallet.approve_credit_transfer')
        ? unwrap(api.GET('/api/v1/wallet/credit-transfers', pending))
        : Promise.resolve(null),
      can(session, 'wallet.approve_credit_transfer')
        ? unwrap(
            api.GET('/api/v1/wallet/credit-transfers', {
              params: { query: { status: 'revoke_requested' } },
            }),
          )
        : Promise.resolve(null),
      // ADR-044: the general manager decides a case's penalty rate from here.
      can(session, 'credit.approve_penalty_override')
        ? unwrap(api.GET('/api/v1/credit/penalty-overrides'))
        : Promise.resolve(null),
    ]);

  return (
    <>
      <PageHeader
        title="عملیات ویژه"
        description="درخواست‌های در انتظار نفر دوم؛ تأیید یا رد با دلیل، هرگز به دست درخواست‌دهنده."
      />

      {purseOps.status === 'rejected'
        ? failed(purseOps.reason)
        : purseOps.value && (
            <Queue id="purse-ops" title="عملیات کیف اعتبار">
              <DataTable
                caption="عملیات کیف در انتظار تأیید"
                rows={purseOps.value}
                rowKey={(r) => r.id}
                empty={<EmptyState title="درخواستی در انتظار نیست." />}
                columns={[
                  { key: 'asked', header: 'درخواست', cell: (r) => showInstant(r.requestedAt) },
                  { key: 'kind', header: 'عمل', cell: (r) => PURSE_OPERATION[r.kind] ?? r.kind },
                  {
                    key: 'amount',
                    header: 'مبلغ',
                    cell: (r) =>
                      r.amountRial
                        ? rial(r.amountRial)
                        : r.kind === 'cancel_unused'
                          ? 'همه مانده'
                          : '—',
                    numeric: true,
                  },
                  { key: 'reason', header: 'دلیل', cell: (r) => r.reason },
                  {
                    key: 'decide',
                    header: 'تصمیم',
                    cell: (r) => (
                      <Decide
                        target={{ kind: 'purse_operation', id: r.id }}
                        mine={r.requestedByMe}
                        approveLabel="تأیید و اجرا"
                      />
                    ),
                  },
                ]}
              />
            </Queue>
          )}

      {cancellations.status === 'rejected'
        ? failed(cancellations.reason)
        : cancellations.value && (
            <Queue id="cancellations" title="انصراف پیش از شارژ">
              <DataTable
                caption="انصراف‌های در انتظار تأیید"
                rows={cancellations.value}
                rowKey={(r) => r.id}
                empty={<EmptyState title="درخواستی در انتظار نیست." />}
                columns={[
                  { key: 'asked', header: 'درخواست', cell: (r) => showInstant(r.requestedAt) },
                  {
                    key: 'application',
                    header: 'پرونده',
                    cell: (r) => (
                      <Link
                        href={`/completion/${r.creditApplicationId}`}
                        className="text-accent underline"
                      >
                        مشاهده
                      </Link>
                    ),
                  },
                  { key: 'reason', header: 'دلیل', cell: (r) => r.reason },
                  {
                    key: 'decide',
                    header: 'تصمیم',
                    cell: (r) => (
                      <Decide
                        target={{ kind: 'cancellation', id: r.id }}
                        mine={r.requestedByMe}
                        approveLabel="تأیید انصراف و استرداد"
                      />
                    ),
                  },
                ]}
              />
            </Queue>
          )}

      {refunds.status === 'rejected'
        ? failed(refunds.reason)
        : refunds.value && (
            <Queue id="refunds" title="پرداخت استرداد">
              <DataTable
                caption="پرداخت‌های استرداد در انتظار تأیید"
                rows={refunds.value}
                rowKey={(r) => r.id}
                empty={<EmptyState title="پرداختی در انتظار نیست." />}
                columns={[
                  { key: 'paid', header: 'روز پرداخت', cell: (r) => showDay(r.paidOn) },
                  { key: 'account', header: 'بابت', cell: (r) => REFUND_ACCOUNT[r.account] },
                  { key: 'amount', header: 'مبلغ', cell: (r) => rial(r.amountRial), numeric: true },
                  {
                    key: 'reference',
                    header: 'پیگیری بانک',
                    cell: (r) => <bdi className="figures">{r.bankReference}</bdi>,
                  },
                  {
                    key: 'application',
                    header: 'پرونده',
                    cell: (r) => (
                      <Link
                        href={`/completion/${r.creditApplicationId}`}
                        className="text-accent underline"
                      >
                        مشاهده
                      </Link>
                    ),
                  },
                  {
                    key: 'decide',
                    header: 'تصمیم',
                    cell: (r) => (
                      <Decide
                        target={{ kind: 'refund_payment', id: r.id }}
                        mine={r.requestedByMe}
                        approveLabel="تأیید پرداخت"
                      />
                    ),
                  },
                ]}
              />
            </Queue>
          )}

      {transfers.status === 'rejected'
        ? failed(transfers.reason)
        : transfers.value && (
            <Queue id="transfers" title="انتقال اعتبار">
              <DataTable
                caption="انتقال‌های در انتظار تأیید"
                rows={transfers.value}
                rowKey={(r) => r.id}
                empty={<EmptyState title="انتقالی در انتظار نیست." />}
                columns={[
                  { key: 'asked', header: 'درخواست', cell: (r) => showInstant(r.requestedAt) },
                  { key: 'recipient', header: 'گیرنده', cell: (r) => r.recipientName ?? '—' },
                  {
                    key: 'mobile',
                    header: 'موبایل',
                    cell: (r) => <bdi className="figures">…{r.recipientMobileLast4}</bdi>,
                  },
                  {
                    key: 'amount',
                    header: 'سقف استفاده',
                    cell: (r) => rial(r.amountRial),
                    numeric: true,
                  },
                  { key: 'reason', header: 'دلیل', cell: (r) => r.reason },
                  {
                    key: 'paper',
                    header: 'سند امضاشده',
                    cell: (r) => (
                      // Never broken at a dash, which read out of order (owner 1405/07/29).
                      <bdi dir="ltr" className="whitespace-nowrap">
                        {r.paperDocumentNumber ?? '—'}
                      </bdi>
                    ),
                  },
                  {
                    key: 'decide',
                    header: 'تصمیم',
                    cell: (r) => (
                      <Decide
                        target={{ kind: 'credit_transfer', id: r.id }}
                        mine={r.requestedByMe}
                        approveLabel="تأیید انتقال"
                        confirm={`سند امضاشده شماره ${r.paperDocumentNumber ?? '—'} دریافت شد.`}
                      />
                    ),
                  },
                ]}
              />
            </Queue>
          )}

      {revokes.status === 'rejected'
        ? failed(revokes.reason)
        : revokes.value && (
            <Queue id="revokes" title="ابطال گیرنده مجاز">
              <DataTable
                caption="ابطال‌های در انتظار تأیید"
                rows={revokes.value}
                rowKey={(r) => r.id}
                empty={<EmptyState title="ابطالی در انتظار نیست." />}
                columns={[
                  {
                    key: 'asked',
                    header: 'درخواست',
                    cell: (r) => (r.revokeRequestedAt ? showInstant(r.revokeRequestedAt) : '—'),
                  },
                  { key: 'recipient', header: 'گیرنده', cell: (r) => r.recipientName ?? '—' },
                  { key: 'reason', header: 'دلیل', cell: (r) => r.revokeReason ?? '—' },
                  {
                    key: 'decide',
                    header: 'تصمیم',
                    cell: (r) => (
                      <Decide
                        target={{ kind: 'credit_transfer_revoke', id: r.id }}
                        mine={r.revokeRequestedByMe}
                        approveLabel="تأیید ابطال"
                      />
                    ),
                  },
                ]}
              />
            </Queue>
          )}

      {penalties.status === 'rejected'
        ? failed(penalties.reason)
        : penalties.value && (
            <Queue id="penalties" title="نرخ خسارت انصراف پرونده">
              <DataTable
                caption="نرخ‌های خسارت در انتظار تأیید"
                rows={penalties.value}
                rowKey={(r) => r.id}
                empty={<EmptyState title="درخواستی در انتظار نیست." />}
                columns={[
                  { key: 'asked', header: 'درخواست', cell: (r) => showInstant(r.requestedAt) },
                  {
                    key: 'rate',
                    header: 'نرخ',
                    cell: (r) => `${faDigits((r.penaltyBps / 100).toString())}٪`,
                    numeric: true,
                  },
                  {
                    key: 'application',
                    header: 'پرونده',
                    cell: (r) => (
                      <Link
                        href={`/completion/${r.creditApplicationId}`}
                        className="text-accent underline"
                      >
                        مشاهده
                      </Link>
                    ),
                  },
                  { key: 'reason', header: 'دلیل', cell: (r) => r.reason },
                  {
                    key: 'decide',
                    header: 'تصمیم',
                    cell: (r) => (
                      <Decide
                        target={{ kind: 'penalty_override', id: r.id }}
                        mine={r.requestedByMe}
                        approveLabel="تأیید نرخ"
                      />
                    ),
                  },
                ]}
              />
            </Queue>
          )}
    </>
  );
}
