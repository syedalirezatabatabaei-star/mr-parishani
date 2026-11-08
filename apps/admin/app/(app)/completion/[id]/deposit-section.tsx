import { unwrap } from '@sepehr/api-client';
import { Notice, rial, showDay, showInstant, StatusBadge, tehranToday } from '@sepehr/ui';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { RecordFormationDeposit, RecordFormationDepositRefund } from './deposit-actions';

/**
 * The formation deposit (owner 1405/07/29, answer f): in the pilot only its details, with no
 * ledger row; the `deposit.held` account comes after the pilot with its own ADR. Recorded by
 * case completion; refunded only before the introduction letter (the purse's charge, by
 * default). Shown only while the configuration asks for a deposit or one was recorded.
 */
export async function DepositSection({ applicationId }: { applicationId: string }) {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const mayRecord = can(session, 'credit.record_formation_deposit');
  if (!mayRecord && !can(session, 'credit.read_applications')) return null;
  let state;
  try {
    state = await unwrap(
      api.GET('/api/v1/credit/applications/{id}/formation-deposit', {
        params: { path: { id: applicationId } },
      }),
    );
  } catch {
    return null;
  }
  const { deposit } = state;
  if (!deposit && state.configuredAmountRial === '0') return null;
  const today = tehranToday();
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-labelledby="deposit"
    >
      <h2 id="deposit" className="flex items-center gap-2 text-[length:var(--text-lg)] font-bold">
        بیعانه تشکیل
        {deposit && (
          <StatusBadge tone={deposit.refund ? 'neutral' : 'success'}>
            {deposit.refund ? 'برگشت داده شد' : 'ثبت شد'}
          </StatusBadge>
        )}
      </h2>
      <Notice tone="info">
        در پایلوت فقط مشخصات بیعانه ثبت می‌شود و در دفتر کل ردیفی ندارد. پس از شارژ کیف اعتبار (صدور
        معرفی‌نامه) برنمی‌گردد.
      </Notice>
      {deposit ? (
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="text-ink-muted">مبلغ</dt>
          <dd className="figures">{rial(deposit.amountRial)}</dd>
          <dt className="text-ink-muted">روز پرداخت</dt>
          <dd className="figures">{showDay(deposit.paidOn)}</dd>
          <dt className="text-ink-muted">شماره پیگیری</dt>
          <dd>
            <bdi dir="ltr" className="figures">
              …{deposit.bankReferenceLast4}
            </bdi>
          </dd>
          {deposit.note && (
            <>
              <dt className="text-ink-muted">یادداشت</dt>
              <dd>{deposit.note}</dd>
            </>
          )}
          <dt className="text-ink-muted">ثبت</dt>
          <dd className="figures">{showInstant(deposit.recordedAt)}</dd>
          {deposit.refund && (
            <>
              <dt className="text-ink-muted">برگشت</dt>
              <dd>
                <span className="figures">{showDay(deposit.refund.refundedOn)}</span>، پیگیری{' '}
                <bdi dir="ltr" className="figures">
                  …{deposit.refund.refundReferenceLast4}
                </bdi>
                ، {deposit.refund.reason}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p>
          مبلغ بیعانه طبق تنظیمات:{' '}
          <span className="figures">{rial(state.configuredAmountRial)}</span>
        </p>
      )}
      {!deposit && mayRecord && (
        <RecordFormationDeposit applicationId={applicationId} today={today} />
      )}
      {deposit && deposit.refundable && mayRecord && (
        <RecordFormationDepositRefund applicationId={applicationId} today={today} />
      )}
      {deposit && !deposit.refund && !deposit.refundable && (
        <p className="text-ink-muted">کیف اعتبار شارژ شده است؛ بیعانه برنمی‌گردد.</p>
      )}
    </section>
  );
}
