import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  Notice,
  rial,
  showDay,
  showInstant,
  StatusBadge,
  tehranToday,
  type StatusTone as Tone,
} from '@sepehr/ui';
import type { ReactNode } from 'react';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import {
  AskCancellation,
  AskCancelAfterFunding,
  AskCancelUnused,
  AskChangeDoctor,
  AskCreditTransfer,
  AskReverse,
  AskRevokeTransfer,
  EnterTransferCodes,
  RecordRefundPayment,
} from '../../special-operations/operation-actions';

const DECISION: Readonly<Record<string, { label: string; tone: Tone }>> = {
  requested: { label: 'در انتظار تأیید', tone: 'warning' },
  approved: { label: 'انجام شد', tone: 'success' },
  rejected: { label: 'رد شد', tone: 'danger' },
};
const TRANSFER: Readonly<Record<string, { label: string; tone: Tone }>> = {
  awaiting_codes: { label: 'منتظر کدها', tone: 'warning' },
  requested: { label: 'در انتظار تأیید', tone: 'warning' },
  approved: { label: 'فعال', tone: 'success' },
  rejected: { label: 'رد شد', tone: 'danger' },
  revoke_requested: { label: 'در انتظار ابطال', tone: 'warning' },
  revoked: { label: 'باطل شد', tone: 'neutral' },
};
const PURSE_OPERATION: Readonly<Record<string, string>> = {
  cancel_unused: 'ابطال مانده مصرف‌نشده',
  reverse_cancel_unused: 'برگشت ابطال',
  change_doctor: 'تغییر پزشک',
  cancel_after_funding: 'انصراف پس از شارژ',
};

const badge = (map: Readonly<Record<string, { label: string; tone: Tone }>>, s: string) => (
  <StatusBadge tone={map[s]?.tone ?? 'neutral'}>{map[s]?.label ?? s}</StatusBadge>
);

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <h3 className="font-bold">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Task 4-8 on an application's page (doc 12 §7): before funding, a cancellation; after it,
 * the purse's operations (what is unused, a new doctor) and a credit transfer; and once
 * something is owed back, its bank payments. Each is asked here and decided by another on
 * «عملیات ویژه». Shown by permission; the API refuses anyway.
 */
export async function SpecialSection({
  applicationId,
  purseId,
}: {
  applicationId: string;
  purseId: string | null;
}) {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const mayCancel = can(session, 'credit.request_cancellation', 'credit.approve_cancellation');
  const mayAskCancel = can(session, 'credit.request_cancellation');
  const mayPurse = can(
    session,
    'wallet.request_special_operation',
    'wallet.approve_special_operation',
    'wallet.request_doctor_change',
    'wallet.approve_doctor_change',
  );
  const mayRefund = can(
    session,
    'contract.request_refund_payment',
    'contract.approve_refund_payment',
  );
  const mayTransfer = can(
    session,
    'wallet.request_credit_transfer',
    'wallet.approve_credit_transfer',
  );
  if (!mayCancel && !mayPurse && !mayRefund && !mayTransfer) return null;
  const byApplication = { params: { query: { creditApplicationId: applicationId } } };
  const byPurse = purseId ? { params: { query: { purseId } } } : null;
  const [cancellations, owed, payments, purseOps, transfers] = await Promise.allSettled([
    mayCancel ? unwrap(api.GET('/api/v1/credit/cancellations', byApplication)) : null,
    mayRefund
      ? unwrap(
          api.GET('/api/v1/refund-payments/owed/{applicationId}', {
            params: { path: { applicationId } },
          }),
        )
      : null,
    mayRefund ? unwrap(api.GET('/api/v1/refund-payments', byApplication)) : null,
    mayPurse && byPurse ? unwrap(api.GET('/api/v1/wallet/special-operations', byPurse)) : null,
    mayTransfer && byPurse ? unwrap(api.GET('/api/v1/wallet/credit-transfers', byPurse)) : null,
  ]);
  const value = <T,>(r: PromiseSettledResult<T | null>): T | null =>
    r.status === 'fulfilled' ? r.value : null;
  const cancellationList = value(cancellations) ?? [];
  const cancelled = cancellationList.some((c) => c.status === 'approved');
  const openCancellation = cancellationList.some((c) => c.status === 'requested');
  const owedNow = value(owed);
  const owesBack = owedNow !== null && (owedNow.feeRial !== '0' || owedNow.downPaymentRial !== '0');
  const paymentList = value(payments) ?? [];
  const opList = value(purseOps) ?? [];
  const transferList = value(transfers) ?? [];
  const liveTransfer = transferList.find((t) =>
    ['awaiting_codes', 'requested', 'approved', 'revoke_requested'].includes(t.status),
  );

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-labelledby="special"
    >
      <h2 id="special" className="text-[length:var(--text-lg)] font-bold">
        عملیات ویژه
      </h2>

      {mayCancel && !purseId && (
        <Part title="انصراف پیش از شارژ">
          {cancelled ? (
            <Notice tone="warning">
              این پرونده باطل شد؛ فیش‌های تأییدشده بدون خسارت به وام‌گیرنده بدهکار شدند.
            </Notice>
          ) : openCancellation ? (
            <p>درخواست انصراف در انتظار تأیید مالی است.</p>
          ) : (
            mayAskCancel && <AskCancellation applicationId={applicationId} />
          )}
        </Part>
      )}

      {mayPurse && purseId && (
        <Part title="عملیات کیف اعتبار">
          <DataTable
            caption="عملیات این کیف"
            rows={opList}
            rowKey={(r) => r.id}
            empty={<p>عملیاتی ثبت نشده است.</p>}
            columns={[
              { key: 'asked', header: 'درخواست', cell: (r) => showInstant(r.requestedAt) },
              { key: 'kind', header: 'عمل', cell: (r) => PURSE_OPERATION[r.kind] ?? r.kind },
              {
                key: 'amount',
                header: 'مبلغ',
                cell: (r) => (r.result?.amountRial ? rial(r.result.amountRial) : '—'),
                numeric: true,
              },
              { key: 'status', header: 'وضعیت', cell: (r) => badge(DECISION, r.status) },
              {
                key: 'detail',
                header: 'جزئیات',
                cell: (r) =>
                  r.kind === 'cancel_after_funding' && r.result ? (
                    <span className="figures">
                      کارمزد بخشوده {rial(r.result.feeWaivedRial ?? '0')} · خسارت{' '}
                      {rial(r.result.penaltyRial ?? '0')}
                      {r.result.penaltyDueOn ? ` با سررسید ${showDay(r.result.penaltyDueOn)}` : ''}
                      {r.result.closed ? ' · کیف بسته شد' : ''}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'reverse',
                header: 'برگشت',
                cell: (r) =>
                  r.kind === 'cancel_unused' &&
                  r.status === 'approved' &&
                  can(session, 'wallet.request_special_operation') &&
                  !opList.some((o) => o.reversesRequestId === r.id && o.status !== 'rejected') ? (
                    <AskReverse requestId={r.id} />
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          {!opList.some((o) => o.status === 'requested') && (
            <div className="grid gap-3 lg:grid-cols-2">
              {can(session, 'wallet.request_special_operation') && (
                <AskCancelUnused purseId={purseId} />
              )}
              {can(session, 'wallet.request_doctor_change') && (
                <AskChangeDoctor purseId={purseId} />
              )}
              {can(session, 'wallet.request_special_operation') && (
                <AskCancelAfterFunding purseId={purseId} />
              )}
            </div>
          )}
        </Part>
      )}

      {mayTransfer && purseId && (
        <Part title="انتقال اعتبار به گیرنده مجاز">
          <DataTable
            caption="انتقال‌های این کیف"
            rows={transferList}
            rowKey={(r) => r.id}
            empty={<p>انتقالی ثبت نشده است.</p>}
            columns={[
              { key: 'asked', header: 'درخواست', cell: (r) => showInstant(r.requestedAt) },
              { key: 'recipient', header: 'گیرنده', cell: (r) => r.recipientName ?? '—' },
              {
                key: 'mobile',
                header: 'موبایل',
                cell: (r) => <bdi className="figures">…{r.recipientMobileLast4}</bdi>,
              },
              { key: 'amount', header: 'سقف', cell: (r) => rial(r.amountRial), numeric: true },
              { key: 'status', header: 'وضعیت', cell: (r) => badge(TRANSFER, r.status) },
            ]}
          />
          {can(session, 'wallet.request_credit_transfer') &&
            (liveTransfer?.status === 'awaiting_codes' ? (
              <EnterTransferCodes id={liveTransfer.id} />
            ) : liveTransfer?.status === 'approved' ? (
              <AskRevokeTransfer id={liveTransfer.id} />
            ) : liveTransfer ? null : (
              <AskCreditTransfer purseId={purseId} />
            ))}
        </Part>
      )}

      {mayRefund && (owesBack || paymentList.length > 0) && (
        <Part title="پرداخت استرداد به وام‌گیرنده">
          {owedNow && (
            <p className="figures">
              مانده قابل استرداد — پیش‌پرداخت: {rial(owedNow.downPaymentRial)} · هزینه‌های پرونده:{' '}
              {rial(owedNow.feeRial)}
            </p>
          )}
          <DataTable
            caption="پرداخت‌های استرداد"
            rows={paymentList}
            rowKey={(r) => r.id}
            empty={<p>پرداختی ثبت نشده است.</p>}
            columns={[
              { key: 'paid', header: 'روز پرداخت', cell: (r) => showDay(r.paidOn) },
              {
                key: 'account',
                header: 'بابت',
                cell: (r) => (r.account === 'fee' ? 'هزینه‌های پرونده' : 'پیش‌پرداخت'),
              },
              { key: 'amount', header: 'مبلغ', cell: (r) => rial(r.amountRial), numeric: true },
              {
                key: 'reference',
                header: 'پیگیری بانک',
                cell: (r) => <bdi className="figures">{r.bankReference}</bdi>,
              },
              { key: 'status', header: 'وضعیت', cell: (r) => badge(DECISION, r.status) },
            ]}
          />
          {owesBack && can(session, 'contract.request_refund_payment') && (
            <RecordRefundPayment
              applicationId={applicationId}
              today={tehranToday()}
              owed={{ fee: rial(owedNow.feeRial), downPayment: rial(owedNow.downPaymentRial) }}
            />
          )}
        </Part>
      )}
    </section>
  );
}
