import { unwrap } from '@sepehr/api-client';
import {
  CONTRACT_STATUS,
  DataTable,
  DELIVERY_ITEM_KIND,
  DELIVERY_ITEM_STATUS,
  DELIVERY_METHOD,
  DELIVERY_STATUS,
  errorMessage,
  faDigits,
  INSTRUMENT_STATUS,
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
import type { ReactNode } from 'react';
import { CREDIT_STATUS } from '../../../../lib/credit';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import {
  ArchiveDelivery,
  CheckCondition,
  CheckDelivery,
  CompleteApplication,
  ConfirmSayad,
  CreateDelivery,
  GenerateContract,
  MarkItem,
  ReceiveDelivery,
  RegisterInstrument,
  ReturnDelivery,
  ShowNumber,
  VerifyInstrument,
  ViewContract,
  ViewReceiptFile,
} from './completion-actions';
import { DecideFunding, RequestFunding } from '../../funding/funding-actions';
import { PenaltySection } from '../../credit/[id]/penalty-section';
import { DepositSection } from './deposit-section';
import { OriginationSection } from './origination-section';
import { SpecialSection } from './special-section';

export const metadata: Metadata = { title: 'تکمیل پرونده | پنل داخلی سپهر' };

function Section({
  id,
  title,
  done,
  children,
}: {
  id: string;
  title: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-labelledby={id}
    >
      <h2 id={id} className="flex items-center gap-2 text-[length:var(--text-lg)] font-bold">
        {title}
        {done !== undefined && (
          <StatusBadge tone={done ? 'success' : 'warning'}>{done ? 'برقرار' : 'مانده'}</StatusBadge>
        )}
      </h2>
      {children}
    </section>
  );
}

/**
 * One approved application on its way to completion (doc 12 §2–§4; task 4-4): the live
 * checklist the service computes, then each condition in turn: the contract and its
 * acceptance, the physical delivery with its cheques and notes, the conditions of a
 * conditional approval, and the receipts finance decides. The service checks every
 * condition again when completion is asked; this page never decides it.
 */
export default async function CompletionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let status;
  try {
    status = await unwrap(
      api.GET('/api/v1/completion/{applicationId}', { params: { path: { applicationId: id } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="تکمیل پرونده" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const query = { params: { query: { creditApplicationId: id } } };
  const mayRequestFunding = can(session, 'wallet.request_funding');
  const mayApproveFunding = can(session, 'wallet.approve_funding');
  const [app, contracts, deliveries, fundings] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/credit/applications/{id}', { params: { path: { id } } })),
    unwrap(api.GET('/api/v1/contracts', query)),
    unwrap(api.GET('/api/v1/deliveries', query)),
    mayRequestFunding || mayApproveFunding
      ? unwrap(api.GET('/api/v1/funding/requests', query))
      : Promise.resolve([]),
  ]);
  const fundingList = fundings.status === 'fulfilled' ? fundings.value : [];
  const funded = fundingList.find((r) => r.status === 'approved');
  const pending = fundingList.find((r) => r.status === 'requested');
  const lastRejected = [...fundingList].reverse().find((r) => r.status === 'rejected');
  const today = tehranToday();
  const mayGenerate = can(session, 'contract.generate');
  const mayManage = can(session, 'instrument.manage');
  // Owner 1405/07/27: promissory notes only while their flag is on (off by default).
  const promissoryNotes = mayManage
    ? await unwrap(api.GET('/api/v1/deliveries/options')).then(
        (o) => o.promissoryNotesEnabled,
        () => false,
      )
    : false;
  const mayViewNumbers = can(session, 'instrument.view_numbers');
  const mayCheck = can(session, 'credit.check_conditions');
  const mayComplete = can(session, 'contract.complete');
  const contractList = contracts.status === 'fulfilled' ? contracts.value : [];
  const contract = contractList.find((c) => c.status !== 'failed');
  const deliveryList = deliveries.status === 'fulfilled' ? deliveries.value : [];
  let guarantorNo = 0;
  const parties = (contract?.parties ?? []).map((p) => ({
    ...p,
    title: p.role === 'borrower' ? 'وام‌گیرنده' : `ضامن ${faDigits(++guarantorNo)}`,
  }));
  const guarantors = parties
    .filter((p) => p.role === 'guarantor' && p.guarantorId)
    .map((p) => ({ id: p.guarantorId ?? '', title: p.title }));
  const titleOf = (role: string, guarantorId: string | null) =>
    role === 'borrower'
      ? 'وام‌گیرنده'
      : (guarantors.find((g) => g.id === guarantorId)?.title ?? 'ضامن');
  const allConditionsChecked = status.conditions.every((c) => c.checkedAt !== null);
  const allReceipts = status.owed.every((o) => o.approved);

  return (
    <>
      <PageHeader
        title="تکمیل پرونده"
        description={
          app.status === 'fulfilled'
            ? `${app.value.planTitle} · ${faDigits(app.value.installmentCount)} قسط`
            : undefined
        }
      />
      <p className="flex flex-wrap items-center gap-3">
        {app.status === 'fulfilled' && (
          <StatusBadge tone={CREDIT_STATUS[app.value.status].tone}>
            {CREDIT_STATUS[app.value.status].label}
          </StatusBadge>
        )}
        {app.status === 'fulfilled' && app.value.approvedAmountRial && (
          <span className="figures">مبلغ مصوب: {toman(app.value.approvedAmountRial)}</span>
        )}
        <Link href={`/credit/${id}`} className="text-accent underline">
          پرونده اعتباری
        </Link>
        <Link href="/completion" className="text-accent underline">
          صف تکمیل
        </Link>
      </p>

      <Section id="checklist" title="چک‌لیست تکمیل">
        {status.completedAt ? (
          <Notice tone="success">
            پرونده در <span className="figures">{showInstant(status.completedAt)}</span> تکمیل شد.
          </Notice>
        ) : status.missing.length === 0 ? (
          <Notice tone="success">همه شرط‌ها برقرار است.</Notice>
        ) : (
          <ul className="list-inside list-disc" aria-label="شرط‌های مانده">
            {status.missing.map((m) => (
              <li key={m}>{missingLabel(m)}</li>
            ))}
          </ul>
        )}
        {!status.completedAt && mayComplete && <CompleteApplication applicationId={id} />}
      </Section>

      {status.completedAt && (mayRequestFunding || mayApproveFunding) && (
        <Section id="funding" title="شارژ کیف اعتبار" done={Boolean(funded)}>
          {funded ? (
            <Notice tone="success">
              کیف اعتبار در{' '}
              <span className="figures">{showInstant(funded.decidedAt ?? funded.requestedAt)}</span>{' '}
              شارژ شد.
            </Notice>
          ) : pending ? (
            <>
              <p>
                درخواست شارژ در <span className="figures">{showInstant(pending.requestedAt)}</span>{' '}
                ثبت شد و در انتظار تأیید مالی است.
              </p>
              {mayApproveFunding && <DecideFunding id={pending.id} mine={pending.requestedByMe} />}
            </>
          ) : (
            <>
              {lastRejected && (
                <Notice tone="warning">
                  درخواست قبلی رد شد: {lastRejected.decisionReason ?? '—'}
                </Notice>
              )}
              {mayRequestFunding ? (
                <RequestFunding applicationId={id} />
              ) : (
                <p className="text-ink-muted">هنوز درخواست شارژی ثبت نشده است.</p>
              )}
            </>
          )}
        </Section>
      )}

      <SpecialSection applicationId={id} purseId={funded?.purseId ?? null} />

      {/* Owner 1405/07/29, answer f: the formation deposit's details, no ledger row. */}
      <DepositSection applicationId={id} />

      {/* ADR-044: accounting asks a case's penalty rate here, before its contract. */}
      <PenaltySection applicationId={id} />

      <Section id="contract" title="قرارداد" done={status.contractAccepted}>
        {!contract ? (
          <>
            <p className="text-ink-muted">قراردادی ساخته نشده است.</p>
            {contractList.some((c) => c.status === 'failed') && (
              <Notice tone="danger">ساخت قبلی ناموفق بود؛ دوباره بسازید.</Notice>
            )}
            {mayGenerate && <GenerateContract applicationId={id} />}
          </>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-3">
              <span>
                شماره <bdi className="figures">{faDigits(contract.number)}</bdi>
              </span>
              <StatusBadge tone={CONTRACT_STATUS[contract.status].tone}>
                {CONTRACT_STATUS[contract.status].label}
              </StatusBadge>
              {contract.sample && (
                <StatusBadge tone="danger">پیش‌نویس — در انتظار تأیید حقوقی</StatusBadge>
              )}
              {contract.status !== 'generating' && <ViewContract id={contract.id} />}
            </p>
            <ul className="space-y-1" aria-label="پذیرش طرفین">
              {parties.map((p) => (
                <li key={`${p.role}-${p.guarantorId ?? ''}`}>
                  {p.title}:{' '}
                  {p.acceptedAt ? (
                    <span className="figures">پذیرفت، {showInstant(p.acceptedAt)}</span>
                  ) : (
                    <span className="text-ink-muted">هنوز نپذیرفته</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section id="delivery" title="مدارک فیزیکی و ابزارها" done={status.deliveryVerified}>
        {deliveryList.length === 0 && mayManage && (
          <CreateDelivery applicationId={id} promissoryNotes={promissoryNotes} />
        )}
        {deliveryList.length === 0 && !mayManage && (
          <p className="text-ink-muted">فهرست مدارک فیزیکی ثبت نشده است.</p>
        )}
        {deliveryList.map((d) => {
          const open = d.status === 'received' || d.status === 'incomplete';
          return (
            <div key={d.id} className="space-y-3 rounded-md border border-border p-3">
              <p className="flex flex-wrap items-center gap-3">
                <StatusBadge tone={DELIVERY_STATUS[d.status].tone}>
                  {DELIVERY_STATUS[d.status].label}
                </StatusBadge>
                {d.method && <span>روش: {DELIVERY_METHOD[d.method]}</span>}
                {d.trackingCode && (
                  <span>
                    رهگیری: <bdi className="figures">{d.trackingCode}</bdi>
                  </span>
                )}
                {d.receivedAt && (
                  <span className="figures">رسیده: {showInstant(d.receivedAt)}</span>
                )}
                {d.archiveLocation && <span>بایگانی: {d.archiveLocation}</span>}
              </p>
              {mayManage && (d.status === 'awaiting_send' || d.status === 'sent') && (
                <ReceiveDelivery id={d.id} />
              )}
              <ul className="space-y-3" aria-label="اقلام">
                {d.items.map((item) => {
                  const instrument = d.instruments.find((x) => x.id === item.instrumentId);
                  const isInstrument = item.kind === 'cheque' || item.kind === 'promissory_note';
                  return (
                    <li key={item.id} className="space-y-2 border-t border-border pt-2">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.label}</span>
                        <span className="text-ink-muted">({DELIVERY_ITEM_KIND[item.kind]})</span>
                        <StatusBadge tone={DELIVERY_ITEM_STATUS[item.status].tone}>
                          {DELIVERY_ITEM_STATUS[item.status].label}
                        </StatusBadge>
                        {mayManage && open && item.status !== 'received' && (
                          <MarkItem deliveryId={d.id} itemId={item.id} />
                        )}
                      </p>
                      {instrument && (
                        <p className="flex flex-wrap items-center gap-2">
                          <span>{titleOf(instrument.role, instrument.guarantorId)}</span>
                          <span className="figures">{toman(instrument.amountRial)}</span>
                          <span>
                            شماره: <bdi className="figures">…{instrument.numberLast4}</bdi>
                          </span>
                          {instrument.dueOn && (
                            <span className="figures">سررسید {showDay(instrument.dueOn)}</span>
                          )}
                          <StatusBadge tone={INSTRUMENT_STATUS[instrument.status].tone}>
                            {INSTRUMENT_STATUS[instrument.status].label}
                          </StatusBadge>
                          {instrument.kind === 'cheque' &&
                            (instrument.sayadConfirmed ? (
                              <StatusBadge tone="success">صیاد تأییدشده</StatusBadge>
                            ) : (
                              mayManage && <ConfirmSayad id={instrument.id} />
                            ))}
                          {mayManage && instrument.status === 'received' && (
                            <VerifyInstrument id={instrument.id} />
                          )}
                          {mayViewNumbers && <ShowNumber id={instrument.id} />}
                        </p>
                      )}
                      {!instrument &&
                        isInstrument &&
                        item.status === 'received' &&
                        mayManage &&
                        open && (
                          <RegisterInstrument
                            deliveryId={d.id}
                            itemId={item.id}
                            kind={item.kind === 'cheque' ? 'cheque' : 'promissory_note'}
                            guarantors={guarantors}
                            today={today}
                          />
                        )}
                    </li>
                  );
                })}
              </ul>
              {mayManage && open && <CheckDelivery id={d.id} />}
              {mayManage && d.status === 'verified' && <ArchiveDelivery id={d.id} />}
              {mayManage && ['sent', 'received', 'incomplete'].includes(d.status) && (
                <ReturnDelivery id={d.id} />
              )}
            </div>
          );
        })}
        {mayManage &&
          deliveryList.length > 0 &&
          deliveryList.every((d) => d.status === 'returned') && (
            <CreateDelivery applicationId={id} promissoryNotes={promissoryNotes} />
          )}
      </Section>

      {status.conditions.length > 0 && (
        <Section id="conditions" title="شرط‌های تأیید" done={allConditionsChecked}>
          <ul className="space-y-2">
            {status.conditions.map((c) => (
              <li key={c.index} className="flex flex-wrap items-center gap-3">
                <span>{c.text}</span>
                {c.checkedAt ? (
                  <StatusBadge tone="success">
                    برقرار، <span className="figures">{showInstant(c.checkedAt)}</span>
                  </StatusBadge>
                ) : (
                  mayCheck && <CheckCondition applicationId={id} index={c.index} />
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ADR-048: the origination fee's waiver and an officer's discount. */}
      <OriginationSection applicationId={id} origination={status.origination} />

      <Section id="receipts" title="فیش‌ها" done={allReceipts}>
        <ul className="space-y-1" aria-label="پرداخت‌های لازم">
          {status.owed.map((o) => (
            <li key={o.kind} className="flex flex-wrap items-center gap-2">
              <span>{RECEIPT_KIND[o.kind]}:</span>
              <span className="figures">{rial(o.expectedRial)}</span>
              <StatusBadge tone={o.approved ? 'success' : 'warning'}>
                {o.approved ? 'تأیید مالی' : 'در انتظار'}
              </StatusBadge>
            </li>
          ))}
        </ul>
        <DataTable
          caption="فیش‌های فرستاده"
          rows={status.receipts}
          rowKey={(r) => r.id}
          empty={<p>فیشی فرستاده نشده است.</p>}
          columns={[
            { key: 'created', header: 'ارسال', cell: (r) => showInstant(r.createdAt) },
            { key: 'kind', header: 'بابت', cell: (r) => RECEIPT_KIND[r.kind] },
            { key: 'amount', header: 'مبلغ', cell: (r) => rial(r.amountRial), numeric: true },
            { key: 'paid', header: 'روز پرداخت', cell: (r) => showDay(r.paidOn) },
            {
              key: 'status',
              header: 'وضعیت',
              cell: (r) => (
                <StatusBadge tone={RECEIPT_STATUS[r.status].tone}>
                  {RECEIPT_STATUS[r.status].label}
                </StatusBadge>
              ),
            },
            { key: 'reason', header: 'دلیل رد', cell: (r) => r.rejectionReason ?? '—' },
            { key: 'file', header: 'فایل', cell: (r) => <ViewReceiptFile id={r.id} /> },
          ]}
        />
      </Section>
    </>
  );
}
