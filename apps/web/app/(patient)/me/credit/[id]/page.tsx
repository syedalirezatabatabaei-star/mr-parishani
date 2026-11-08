import { unwrap } from '@sepehr/api-client';
import {
  CONTRACT_STATUS,
  DELIVERY_ITEM_STATUS,
  DELIVERY_STATUS,
  errorMessage,
  faDigits,
  missingLabel,
  Notice,
  PageHeader,
  RECEIPT_KIND,
  RECEIPT_STATUS,
  rial,
  showDay,
  showInstant,
  StatusBadge,
  tehranToday,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CREDIT_OPEN, CREDIT_STATUS } from '../../../../../lib/credit';
import { serverApi } from '../../../../../lib/server-api';
import {
  ConsentForm,
  DocumentList,
  InviteGuarantor,
  ShortfallForm,
  SubmitApplication,
} from '../credit-forms';
import { DeclareSent, ReceiptUpload } from '../completion-forms';
import { PurseSection } from '../purse-section';
import { RecipientSection } from '../recipient-section';

/** Decided in favour: the contract, the papers and the receipts follow (doc 12 §2–§4). */
const APPROVED: readonly string[] = ['approved', 'conditional'];

export const metadata: Metadata = {
  title: 'درخواست اعتبار | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * One credit application for its patient or borrower (doc 10 §4–§7): where it stands and
 * what is next: submit, consent, documents, guarantors; once decided, the approved amount
 * and any conditions. Never a score or the reason of a rejection (doc 10 §6).
 */
export default async function MyCreditApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const api = await serverApi();
  let app;
  try {
    app = await unwrap(
      api.GET('/api/v1/me/credit-applications/{id}', { params: { path: { id } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="درخواست اعتبار" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const open = CREDIT_OPEN.includes(app.status);
  const approved = APPROVED.includes(app.status);
  // A draft's own figures from its locked versions, before it is submitted (M1 §8.7, ب).
  const lockedQuote =
    app.status === 'draft'
      ? await unwrap(
          api.GET('/api/v1/me/credit-applications/{id}/locked-quote', {
            params: { path: { id } },
          }),
        ).catch(() => null)
      : null;
  const [documents, consent, plans, contracts, deliveries, completion] = await Promise.allSettled([
    app.status === 'draft'
      ? Promise.resolve(null)
      : unwrap(
          api.GET('/api/v1/me/credit-applications/{id}/documents', { params: { path: { id } } }),
        ),
    open ? unwrap(api.GET('/api/v1/me/credit/consent-text')) : Promise.resolve(null),
    app.shortfallKind === 'large'
      ? unwrap(
          api.GET('/api/v1/me/proformas/{id}/plans', { params: { path: { id: app.proformaId } } }),
        )
      : Promise.resolve(null),
    approved ? unwrap(api.GET('/api/v1/me/contracts')) : Promise.resolve([]),
    approved ? unwrap(api.GET('/api/v1/me/deliveries')) : Promise.resolve([]),
    approved
      ? unwrap(
          api.GET('/api/v1/me/completion/{applicationId}', {
            params: { path: { applicationId: id } },
          }),
        )
      : Promise.resolve(null),
  ]);
  const contract =
    contracts.status === 'fulfilled'
      ? contracts.value.find((c) => c.creditApplicationId === app.id)
      : undefined;
  const myDeliveries =
    deliveries.status === 'fulfilled'
      ? deliveries.value.filter((d) => d.creditApplicationId === app.id)
      : [];
  const done = completion.status === 'fulfilled' ? completion.value : null;
  // Once completed: the purse, if funded, and what was used from it (task 4-7).
  const [funding, used, transfers] = await Promise.allSettled([
    done?.completedAt
      ? unwrap(
          api.GET('/api/v1/me/funding/{applicationId}', {
            params: { path: { applicationId: id } },
          }),
        )
      : Promise.resolve(null),
    done?.completedAt ? unwrap(api.GET('/api/v1/me/service/authorizations')) : Promise.resolve([]),
    // Task 4-8: the borrower's AuthorizedRecipient, if any (borrower only; else none).
    done?.completedAt
      ? unwrap(
          api.GET('/api/v1/me/credit-transfers/{applicationId}', {
            params: { path: { applicationId: id } },
          }),
        )
      : Promise.resolve([]),
  ]);
  const purse = funding.status === 'fulfilled' && funding.value?.funded ? funding.value : null;
  const usedHere =
    used.status === 'fulfilled' ? used.value.filter((u) => u.creditApplicationId === app.id) : [];
  const people = documents.status === 'fulfilled' ? (documents.value?.people ?? []) : [];
  const mine = people.find((p) => p.role === 'borrower');
  const status = CREDIT_STATUS[app.status];
  const shortfallCounts =
    plans.status === 'fulfilled'
      ? (plans.value?.plans
          .find((p) => p.code === app.planCode)
          ?.options.map((o) => o.installmentCount) ?? [])
      : [];

  return (
    <>
      <PageHeader
        title="درخواست اعتبار"
        description={`${app.planTitle} · ${faDigits(app.installmentCount)} قسط`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        {app.needsMoreGuarantors && <StatusBadge tone="warning">ضامن بیشتر لازم است</StatusBadge>}
        {app.caseGroupId && <StatusBadge tone="neutral">بخشی از یک گروه درمان</StatusBadge>}
      </div>
      <dl className="grid gap-2 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
        <Amount label="مبلغ این درخواست از پیش‌فاکتور" value={app.proformaTotalRial} />
        <Amount label="پیش‌پرداخت" value={app.downPaymentRial} />
        <Amount label="مبلغ وام درخواستی" value={app.loanRial} />
        <Amount label="جمع اقساط" value={app.totalObligationRial} />
        {app.approvedAmountRial && <Amount label="مبلغ مصوب" value={app.approvedAmountRial} />}
        {app.approvedCashTopUpRial && app.approvedCashTopUpRial !== '0' && (
          <Amount label="مابه‌التفاوت نقدی" value={app.approvedCashTopUpRial} />
        )}
      </dl>

      {purse && <PurseSection funding={purse} used={usedHere} />}
      {purse && transfers.status === 'fulfilled' && (
        <RecipientSection applicationId={app.id} transfers={transfers.value} />
      )}
      {app.status === 'draft' && lockedQuote && (
        <section className="space-y-3" aria-labelledby="locked-title">
          <h2 id="locked-title" className="text-[length:var(--text-lg)] font-bold">
            مبالغ قطعی این درخواست
          </h2>
          <p className="text-[length:var(--text-sm)]">
            این مبالغ با پیکربندی لحظه ثبت درخواست قفل شده‌اند و با ارسال، همین‌ها را می‌پذیرید.
          </p>
          <dl className="grid gap-2 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
            <Amount label="هزینه تشکیل پرونده" value={lockedQuote.quote.originationFeeRial} />
            <Amount
              label={
                lockedQuote.quote.planFeeTiming === 'spread'
                  ? 'کارمزد طرح (در اقساط)'
                  : 'کارمزد طرح (هنگام تکمیل)'
              }
              value={lockedQuote.quote.planFeeRial}
            />
            <Amount label="جمع اقساط" value={lockedQuote.quote.totalObligationRial} />
            <Amount label="جمع همه پرداخت‌ها" value={lockedQuote.quote.totalPayableRial} />
          </dl>
          <table className="w-full text-[length:var(--text-sm)]">
            <caption className="text-start font-bold">جدول اقساط</caption>
            <thead>
              <tr>
                <th scope="col" className="text-start">
                  قسط
                </th>
                <th scope="col" className="text-start">
                  سررسید (تقریبی)
                </th>
                <th scope="col" className="text-start">
                  مبلغ
                </th>
              </tr>
            </thead>
            <tbody>
              {lockedQuote.quote.installments.map((i) => (
                <tr key={i.index} className="border-t border-border">
                  <td className="figures">{faDigits(i.index)}</td>
                  <td className="figures">{showDay(i.dueOn)}</td>
                  <td className="figures">{toman(i.amountRial)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[length:var(--text-xs)] text-ink-subtle">
            مبالغ قطعی‌اند؛ سررسیدها تقریبی‌اند و از روز واریز به کیف اعتبار حساب می‌شوند.
          </p>
        </section>
      )}
      {app.status === 'draft' && <SubmitApplication id={app.id} />}
      {app.status === 'rejected' && (
        <Notice tone="danger">
          درخواست شما تأیید نشد. برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.
        </Notice>
      )}
      {app.conditions && app.conditions.length > 0 && (
        <section className="space-y-2" aria-labelledby="conditions-title">
          <h2 id="conditions-title" className="font-bold">
            شرط‌های تأیید
          </h2>
          <ul className="list-inside list-disc">
            {app.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      )}
      {approved && (
        <section
          className="space-y-4 rounded-lg border border-border bg-surface p-4"
          aria-labelledby="completion-title"
        >
          <h2 id="completion-title" className="text-[length:var(--text-lg)] font-bold">
            قرارداد و تکمیل پرونده
          </h2>
          {done?.completedAt ? (
            <Notice tone="success">
              پرونده شما در <span className="figures">{showInstant(done.completedAt)}</span> تکمیل
              شد.
            </Notice>
          ) : (
            done &&
            done.missing.length > 0 && (
              <div>
                <p className="font-medium">تا تکمیل پرونده مانده است:</p>
                <ul className="list-inside list-disc">
                  {done.missing.map((m) => (
                    <li key={m}>{missingLabel(m)}</li>
                  ))}
                </ul>
              </div>
            )
          )}

          <div className="space-y-2">
            <h3 className="font-bold">قرارداد</h3>
            {contract ? (
              <p className="flex flex-wrap items-center gap-3">
                <StatusBadge tone={CONTRACT_STATUS[contract.status].tone}>
                  {CONTRACT_STATUS[contract.status].label}
                </StatusBadge>
                <Link href={`/me/contracts/${contract.id}`} className="text-accent underline">
                  مشاهده و پذیرش قرارداد
                </Link>
              </p>
            ) : (
              <p className="text-ink-muted">قرارداد هنوز آماده نشده است.</p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="font-bold">مدارک فیزیکی</h3>
            {myDeliveries.length === 0 && (
              <p className="text-ink-muted">فهرست مدارک فیزیکی هنوز اعلام نشده است.</p>
            )}
            {myDeliveries.map((d) => (
              <div key={d.id} className="space-y-2 rounded-md border border-border p-3">
                <StatusBadge tone={DELIVERY_STATUS[d.status].tone}>
                  {DELIVERY_STATUS[d.status].label}
                </StatusBadge>
                <ul className="space-y-1" aria-label="اقلام مدارک فیزیکی">
                  {d.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center gap-2">
                      <span>{i.label}</span>
                      <StatusBadge tone={DELIVERY_ITEM_STATUS[i.status].tone}>
                        {DELIVERY_ITEM_STATUS[i.status].label}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
                {d.status === 'awaiting_send' && <DeclareSent id={d.id} />}
              </div>
            ))}
          </div>

          {done && done.owed.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-bold">فیش‌های پرداخت</h3>
              <p className="text-[length:var(--text-sm)]">
                مبالغ زیر را به حساب شرکت آرامش ثروت واریز کنید و فیش هر کدام را جدا بفرستید.
              </p>
              {done.owed.map((o) => {
                const sent = done.receipts.filter((r) => r.kind === o.kind);
                const waiting = sent.some((r) => r.status === 'pending_approval');
                return (
                  <div key={o.kind} className="space-y-2 rounded-md border border-border p-3">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{RECEIPT_KIND[o.kind]}:</span>
                      <span className="figures font-bold">{rial(o.expectedRial)}</span>
                      <span className="figures text-ink-muted">({toman(o.expectedRial)})</span>
                      {o.approved && <StatusBadge tone="success">پرداخت تأیید شد</StatusBadge>}
                    </p>
                    {sent.length > 0 && (
                      <ul className="space-y-1" aria-label={`فیش‌های ${RECEIPT_KIND[o.kind]}`}>
                        {sent.map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center gap-2">
                            <span className="figures">
                              {rial(r.amountRial)} · {showDay(r.paidOn)}
                            </span>
                            <StatusBadge tone={RECEIPT_STATUS[r.status].tone}>
                              {RECEIPT_STATUS[r.status].label}
                            </StatusBadge>
                            {r.rejectionReason && (
                              <span className="text-[length:var(--text-sm)] text-danger">
                                دلیل: {r.rejectionReason}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {!o.approved && !waiting && !done.completedAt && (
                      <ReceiptUpload
                        applicationId={app.id}
                        kind={o.kind}
                        expectedRial={o.expectedRial}
                        today={tehranToday()}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
      {app.shortfallKind === 'small' && (
        <Notice tone="info">مابه‌التفاوت را هنگام درمان نقدی به پزشک می‌پردازید.</Notice>
      )}
      {app.shortfallKind === 'large' && shortfallCounts.length > 0 && (
        <section className="space-y-2" aria-labelledby="shortfall-title">
          <h2 id="shortfall-title" className="font-bold">
            وام برای مابقی هزینه
          </h2>
          <p className="text-[length:var(--text-sm)]">
            مبلغ مصوب کمتر از هزینه درمان است. می‌توانید برای مابقی درخواست جداگانه بدهید.
          </p>
          <ShortfallForm id={app.id} planCode={app.planCode} counts={shortfallCounts} />
        </section>
      )}

      {open && mine && consent.status === 'fulfilled' && consent.value && (
        <ConsentForm id={app.id} role="borrower" text={consent.value.text} />
      )}
      {mine && (
        <section className="space-y-2" aria-labelledby="documents-title">
          <h2 id="documents-title" className="font-bold">
            مدارک وام‌گیرنده
          </h2>
          <DocumentList id={app.id} role="borrower" items={mine.items} canUpload={open} />
        </section>
      )}
      {open && (
        <section className="space-y-2" aria-labelledby="guarantor-title">
          <h2 id="guarantor-title" className="font-bold">
            ضامن
          </h2>
          <p className="text-[length:var(--text-sm)] text-ink-muted">
            ضامن پس از بررسی رتبه وام‌گیرنده و در صورت نیاز معرفی می‌شود.
          </p>
          <InviteGuarantor id={app.id} />
        </section>
      )}
    </>
  );
}

function Amount({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="figures font-bold">{toman(value)}</dd>
    </div>
  );
}
