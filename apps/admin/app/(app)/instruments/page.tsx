import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  EXECUTION_STATE,
  faDigits,
  Notice,
  PageHeader,
  showDay,
  showInstant,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { ApproveExecution, RecordOutcome, ReleaseInstrument } from './execution-actions';

export const metadata: Metadata = { title: 'چک‌ها: اجرا و استرداد | پنل داخلی سپهر' };

/**
 * Cheques of overdue loans (task 6-8; doc 15 §6): proposed by the collection agent, approved
 * by the collection manager and by finance (three people), presented, cleared through 6-2 or
 * bounced; refused clearances alerted; instruments of settled loans released by accounting.
 * Numbers only by their last four characters.
 */
export default async function InstrumentsPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const approver = can(
    session,
    'instrument.approve_execution_collection',
    'instrument.approve_execution_finance',
  );
  const finance = can(session, 'instrument.record_outcome');
  const releaseApprover = can(session, 'instrument.approve_release');
  const releaseRequester = can(session, 'instrument.request_release');
  const releaser = releaseApprover || releaseRequester;
  let executions;
  let alerts;
  let due;
  try {
    [executions, alerts, due] = await Promise.all([
      unwrap(api.GET('/api/v1/instrument-executions', { params: { query: {} } })),
      approver ? unwrap(api.GET('/api/v1/instrument-executions/alerts')) : Promise.resolve([]),
      releaser ? unwrap(api.GET('/api/v1/instrument-releases/due')) : Promise.resolve([]),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="چک‌ها: اجرا و استرداد" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="چک‌ها: اجرا و استرداد"
        description="ارائه چک با سه نفر متفاوت؛ وصول از مسیر فیش و تخصیص؛ استرداد پس از تسویه کامل."
      />
      {alerts.length > 0 && (
        <Notice tone="danger">
          <p className="font-bold">وصول {faDigits(alerts.length)} چک ارائه‌شده رد می‌شود</p>
          <p>
            مبلغ چک از مانده بدهی بیشتر است؛ هیچ مبلغی در حساب معلق ثبت نمی‌شود (پرسش باز ۶.۱۰).
          </p>
          <ul className="list-inside list-disc">
            {alerts.map((a) => (
              <li key={a.executionId} className="figures">
                چک پایان <bdi>{faDigits(a.numberLast4)}</bdi>: {toman(a.amountRial)}؛ مانده{' '}
                {toman(a.owedRial)}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <DataTable
        caption="اجرای چک‌ها"
        rows={executions}
        rowKey={(r) => r.id}
        empty={<EmptyState title="اجرایی ثبت نشده است." />}
        columns={[
          { key: 'at', header: 'پیشنهاد', cell: (r) => showInstant(r.proposedAt) },
          {
            key: 'cheque',
            header: 'چک',
            cell: (r) => (
              <span className="figures">
                پایان <bdi>{faDigits(r.numberLast4)}</bdi>
                {r.dueOn ? `، سررسید ${showDay(r.dueOn)}` : ''}
              </span>
            ),
          },
          { key: 'amount', header: 'مبلغ', cell: (r) => toman(r.amountRial), numeric: true },
          { key: 'reason', header: 'دلیل پیشنهاد', cell: (r) => r.proposalReason },
          {
            key: 'state',
            header: 'وضعیت',
            cell: (r) => (
              <span className="space-y-1">
                <StatusBadge tone={EXECUTION_STATE[r.status].tone}>
                  {EXECUTION_STATE[r.status].label}
                </StatusBadge>
                {r.status === 'proposed' && (
                  <span className="block text-ink-muted">
                    مدیر وصول: {r.collectionApprovedBy ? 'تأیید کرد' : 'منتظر'}، مالی:{' '}
                    {r.financeApprovedBy ? 'تأیید کرد' : 'منتظر'}
                  </span>
                )}
              </span>
            ),
          },
          {
            key: 'act',
            header: 'اقدام',
            cell: (r) =>
              r.status === 'proposed' && approver ? (
                <ApproveExecution
                  id={r.id}
                  collection={
                    can(session, 'instrument.approve_execution_collection') &&
                    !r.collectionApprovedBy
                  }
                  finance={
                    can(session, 'instrument.approve_execution_finance') && !r.financeApprovedBy
                  }
                />
              ) : r.status === 'presented' && finance ? (
                <RecordOutcome id={r.id} />
              ) : (
                '—'
              ),
          },
        ]}
      />
      {releaser && (
        <DataTable
          caption="استرداد: ابزارهای وام‌های تسویه‌شده"
          rows={due}
          rowKey={(r) => r.instrumentId}
          empty={<EmptyState title="ابزاری برای استرداد نیست." />}
          columns={[
            {
              key: 'kind',
              header: 'ابزار',
              cell: (r) => (
                <span className="figures">
                  {r.kind === 'cheque' ? 'چک' : 'سفته'} پایان <bdi>{faDigits(r.numberLast4)}</bdi>
                </span>
              ),
            },
            {
              key: 'role',
              header: 'صاحب',
              cell: (r) => (r.role === 'guarantor' ? 'ضامن' : 'وام‌گیرنده'),
            },
            { key: 'amount', header: 'مبلغ', cell: (r) => toman(r.amountRial), numeric: true },
            {
              key: 'go',
              header: 'استرداد',
              cell: (r) => (
                <ReleaseInstrument
                  id={r.instrumentId}
                  pending={r.pendingRequest}
                  me={session?.me.accountId ?? ''}
                  canRequest={releaseRequester}
                  canApprove={releaseApprover}
                />
              ),
            },
          ]}
        />
      )}
    </>
  );
}
