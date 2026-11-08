import { unwrap } from '@sepehr/api-client';
import {
  ACTION_KIND,
  actionOutcome,
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  INSTALLMENT_STATE,
  Notice,
  PageHeader,
  PROMISE_STATE,
  showDay,
  showInstant,
  StatusBadge,
  TASK_KIND,
  TASK_STATE,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import {
  CancelPromise,
  DecideTask,
  NewPromise,
  ProposeExecution,
  ProposeTask,
  RecordAction,
  SendGuarantorSms,
  WorkTask,
} from '../collection-actions';

export const metadata: Metadata = { title: 'پرونده معوق | پنل داخلی سپهر' };

/**
 * One overdue case as the collection unit sees it (task 6-7; doc 15 §5; doc 04 §4): the
 * borrower and guarantors by name and mobile, installments, payments, actions, promises and
 * tasks. Never the treatment, the doctor or the center (the API sends none of them).
 */
export default async function CollectionItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let item;
  try {
    item = await unwrap(api.GET('/api/v1/collection/items/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="پرونده معوق" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const canPropose = can(session, 'instrument.propose_execution');
  const candidates = canPropose
    ? await unwrap(
        api.GET('/api/v1/instrument-executions/candidates', {
          params: { query: { caseId: item.caseId } },
        }),
      ).catch(() => [])
    : [];
  const open = item.closedAt === null;
  const works = can(session, 'collection.work_tasks');
  const decides = can(session, 'collection.decide_escalation');
  const overdue = item.installments.filter((i) => i.daysPastDue > 0 && i.outstandingRial !== '0');

  return (
    <>
      <PageHeader title={`پرونده معوق: ${item.borrower.name ?? 'بی‌نام'}`} />
      <p>
        <Link href="/collection" className="text-accent underline">
          بازگشت به صف
        </Link>
      </p>
      {!open && <Notice tone="info">این پرونده از صف بیرون رفته است.</Notice>}
      <section className="grid gap-3 sm:grid-cols-2" aria-label="اشخاص">
        <div className="rounded-md border border-border p-3">
          <h2 className="font-bold">وام‌گیرنده</h2>
          <p>{item.borrower.name ?? 'بی‌نام'}</p>
          <p className="figures" dir="ltr">
            {item.borrower.mobile ? faDigits(`0${item.borrower.mobile}`) : '—'}
          </p>
          {item.borrower.held && (
            <StatusBadge tone="neutral">فوت یا ازکارافتادگی ثبت‌شده</StatusBadge>
          )}
        </div>
        <div className="rounded-md border border-border p-3">
          <h2 className="font-bold">ضامن‌ها</h2>
          {item.guarantors.length === 0 ? (
            <p>ضامنی ندارد.</p>
          ) : (
            <ul>
              {item.guarantors.map((g) => (
                <li key={g.guarantorId}>
                  {g.name ?? 'بی‌نام'}،{' '}
                  <bdi className="figures">{g.mobile ? faDigits(`0${g.mobile}`) : '—'}</bdi>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <DataTable
        caption={`اقساط معوق (${faDigits(overdue.length)})`}
        rows={item.installments}
        rowKey={(i) => `${i.scheduleId}-${String(i.index)}`}
        empty={<EmptyState title="قسطی نیست." />}
        columns={[
          { key: 'n', header: 'قسط', cell: (i) => faDigits(i.index), numeric: true },
          { key: 'due', header: 'سررسید', cell: (i) => showDay(i.dueOn) },
          { key: 'amount', header: 'مبلغ', cell: (i) => toman(i.amountRial), numeric: true },
          { key: 'left', header: 'مانده', cell: (i) => toman(i.outstandingRial), numeric: true },
          { key: 'days', header: 'روز معوق', cell: (i) => faDigits(i.daysPastDue), numeric: true },
          {
            key: 'state',
            header: 'وضعیت',
            cell: (i) => {
              const s = (
                INSTALLMENT_STATE as Readonly<
                  Record<string, (typeof INSTALLMENT_STATE)['paid'] | undefined>
                >
              )[i.status];
              return s ? <StatusBadge tone={s.tone}>{s.label}</StatusBadge> : i.status;
            },
          },
        ]}
      />
      <DataTable
        caption="کارها"
        rows={item.tasks}
        rowKey={(t) => t.id}
        empty={<EmptyState title="کاری نیست." />}
        columns={[
          { key: 'kind', header: 'کار', cell: (t) => TASK_KIND[t.kind] },
          {
            key: 'state',
            header: 'وضعیت',
            cell: (t) => (
              <StatusBadge tone={TASK_STATE[t.status].tone}>
                {TASK_STATE[t.status].label}
              </StatusBadge>
            ),
          },
          { key: 'at', header: 'ساخت', cell: (t) => showInstant(t.createdAt) },
          {
            key: 'act',
            header: 'اقدام',
            cell: (t) => {
              if (t.status === 'open' && works && t.kind === 'guarantor_notice')
                return <SendGuarantorSms id={t.id} />;
              if (t.status === 'open' && works && t.stage >= 3) return <ProposeTask id={t.id} />;
              if (t.status === 'open' && works) return <WorkTask id={t.id} />;
              if (t.status === 'proposed' && decides) return <DecideTask id={t.id} />;
              return '—';
            },
          },
        ]}
      />
      {canPropose && candidates.length > 0 && open && (
        <section className="space-y-2" aria-labelledby="cheques-title">
          <h2 id="cheques-title" className="font-bold">
            چک‌های نزد سپهر
          </h2>
          <ul className="space-y-2">
            {candidates.map((c) => (
              <li key={c.instrumentId} className="flex flex-wrap items-center gap-3">
                <span className="figures">
                  {c.kind === 'cheque' ? 'چک' : 'سفته'} پایان <bdi>{faDigits(c.numberLast4)}</bdi>،{' '}
                  {toman(c.amountRial)}
                  {c.dueOn ? `، سررسید ${showDay(c.dueOn)}` : ''}
                </span>
                {c.kind === 'cheque' ? (
                  <ProposeExecution instrumentId={c.instrumentId} />
                ) : (
                  <span className="text-ink-muted">سفته فقط از ارجاع حقوقی (مرحله ۴)</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <DataTable
        caption="وعده‌های پرداخت"
        rows={item.promises}
        rowKey={(p) => p.id}
        empty={<EmptyState title="وعده‌ای ثبت نشده است." />}
        columns={[
          { key: 'on', header: 'روز وعده', cell: (p) => showDay(p.promisedOn) },
          { key: 'amount', header: 'مبلغ', cell: (p) => toman(p.amountRial), numeric: true },
          {
            key: 'state',
            header: 'وضعیت',
            cell: (p) => (
              <StatusBadge tone={PROMISE_STATE[p.status].tone}>
                {PROMISE_STATE[p.status].label}
              </StatusBadge>
            ),
          },
          {
            key: 'cancel',
            header: 'لغو',
            cell: (p) => (p.status === 'open' ? <CancelPromise id={p.id} /> : '—'),
          },
        ]}
      />
      {open && can(session, 'collection.manage_promises') && <NewPromise itemId={item.itemId} />}
      <DataTable
        caption="اقدام‌ها"
        rows={item.actions}
        rowKey={(a) => a.id}
        empty={<EmptyState title="اقدامی ثبت نشده است." />}
        columns={[
          { key: 'at', header: 'زمان', cell: (a) => showInstant(a.occurredAt) },
          { key: 'kind', header: 'نوع', cell: (a) => ACTION_KIND[a.kind] },
          { key: 'outcome', header: 'نتیجه', cell: (a) => actionOutcome(a.outcome) },
          { key: 'note', header: 'توضیح', cell: (a) => a.note ?? '—' },
        ]}
      />
      {open && can(session, 'collection.record_action') && <RecordAction itemId={item.itemId} />}
    </>
  );
}
