import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  DISPUTE_STATUS,
  EmptyState,
  errorMessage,
  Notice,
  PageHeader,
  showInstant,
  STAFF_TICKET_STATUS,
  StatusBadge,
  TICKET_EVENT,
  TicketAttachmentButton,
  TicketDeadline,
  TicketReply,
  TicketThread,
  ticketTitle,
  ticketUnit,
} from '@sepehr/ui';
import type { DisputeStatus } from '@sepehr/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import {
  AssignForm,
  DisputeDecision,
  FlagMessage,
  StatusForm,
  TransferForm,
} from './staff-actions';

export const metadata: Metadata = { title: 'تیکت | پنل داخلی سپهر' };

/** An event's reason; the dispute's decision (7-2's consumer writes its code) in words. */
function reasonText(reason: string | null): string {
  if (reason === null) return '—';
  const decided = /^dispute (\w+)$/.exec(reason)?.[1] ?? null;
  return isDisputeStatus(decided) ? `تعیین تکلیف اختلاف: ${DISPUTE_STATUS[decided].label}` : reason;
}

const LIVE = new Set(['open', 'assigned', 'in_progress', 'waiting_on_requester', 'reopened']);
const isDisputeStatus = (s: string | null): s is DisputeStatus => s !== null && s in DISPUTE_STATUS;

/**
 * A ticket as staff work it (task 7-7; doc 17 §1): the whole conversation with the internal
 * notes, its history, its state, transfer and assignment; for a financial complaint, the
 * dispute that holds its item and, for accounting, its decision (5-2's own endpoint).
 */
export default async function StaffTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session, api] = await Promise.all([getSession(), serverApi()]);
  let ticket;
  try {
    ticket = await unwrap(api.GET('/api/v1/tickets/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="تیکت" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const work = can(session, 'ticket.work', 'ticket.assign');
  // Task 7-7: the unit's agents by name, for who may assign (none if the list fails: the
  // form then is not shown, the rest of the page still is).
  const agents = can(session, 'ticket.assign')
    ? await unwrap(
        api.GET('/api/v1/tickets/units/{unit}/agents', {
          params: { path: { unit: ticket.unit } },
        }),
      ).catch(() => null)
    : null;
  const live = LIVE.has(ticket.status);
  const financial = ticket.financialDisputeId !== null;
  const disputeStatus = isDisputeStatus(ticket.disputeStatus) ? ticket.disputeStatus : null;
  return (
    <>
      <PageHeader title={ticketTitle(ticket)} />
      <Link href={`/tickets?unit=${ticket.unit}`} className="text-accent underline">
        صف {ticketUnit(ticket.unit)}
      </Link>
      <dl className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-[length:var(--text-sm)] text-ink-muted">وضعیت</dt>
          <dd>
            <StatusBadge tone={STAFF_TICKET_STATUS[ticket.status].tone}>
              {STAFF_TICKET_STATUS[ticket.status].label}
            </StatusBadge>
          </dd>
        </div>
        <div>
          <dt className="text-[length:var(--text-sm)] text-ink-muted">واحد</dt>
          <dd>{ticketUnit(ticket.unit)}</dd>
        </div>
        <div>
          <dt className="text-[length:var(--text-sm)] text-ink-muted">مهلت پاسخ</dt>
          <dd className="figures">
            <TicketDeadline dueAt={ticket.dueAt} paused={ticket.paused} now={new Date()} />
          </dd>
        </div>
        <div>
          <dt className="text-[length:var(--text-sm)] text-ink-muted">کارشناس</dt>
          <dd>
            {ticket.assigneeAccountId === null
              ? 'بی کارشناس'
              : ticket.assigneeAccountId === session?.me.accountId
                ? 'شما'
                : ticket.assigneeAccountId.slice(0, 8)}
          </dd>
        </div>
      </dl>

      {financial && (
        <section className="space-y-3 rounded-lg border border-border-strong bg-surface p-4">
          <h2 className="font-bold text-ink">اختلاف مالی</h2>
          <p>
            قلم پیوندشده تا تعیین تکلیف در هیچ صورت‌وضعیتی نمی‌آید. این شکایت با تصمیم حسابداری بسته
            می‌شود.
          </p>
          {disputeStatus && (
            <p>
              وضعیت اختلاف:{' '}
              <StatusBadge tone={DISPUTE_STATUS[disputeStatus].tone}>
                {DISPUTE_STATUS[disputeStatus].label}
              </StatusBadge>
            </p>
          )}
          {can(session, 'settlement.resolve_dispute') && ticket.financialDisputeId && (
            <DisputeDecision
              disputeId={ticket.financialDisputeId}
              status={ticket.disputeStatus ?? ''}
            />
          )}
        </section>
      )}

      <TicketThread
        reader="staff"
        messages={ticket.messages}
        attachments={ticket.attachments}
        links={ticket.links}
        openAttachment={(a) => (
          <TicketAttachmentButton
            side="staff"
            id={ticket.id}
            attachmentId={a.id}
            label={a.contentType === 'application/pdf' ? 'دریافت PDF' : 'دریافت تصویر'}
          />
        )}
        {...(work
          ? {
              messageAction: (m: { id: string; containsTreatment?: boolean | undefined }) =>
                m.containsTreatment === true ? null : (
                  <FlagMessage id={ticket.id} messageId={m.id} />
                ),
            }
          : {})}
      />
      {work && live && <TicketReply side="staff" id={ticket.id} />}
      {work && live && (
        <div className="grid gap-4 lg:grid-cols-3">
          <StatusForm id={ticket.id} financial={financial} />
          <TransferForm id={ticket.id} unit={ticket.unit} />
          {agents && session && (
            <AssignForm id={ticket.id} me={session.me.accountId} agents={agents} />
          )}
        </div>
      )}

      <DataTable
        caption="سابقه"
        rows={ticket.events}
        rowKey={(e) => `${e.kind}:${e.createdAt}`}
        empty={<EmptyState title="سابقه‌ای نیست." />}
        columns={[
          { key: 'when', header: 'زمان', cell: (e) => showInstant(e.createdAt) },
          { key: 'kind', header: 'رویداد', cell: (e) => TICKET_EVENT[e.kind] },
          {
            key: 'change',
            header: 'تغییر',
            cell: (e) =>
              e.toStatus
                ? STAFF_TICKET_STATUS[e.toStatus].label
                : e.toUnit
                  ? ticketUnit(e.toUnit)
                  : '—',
          },
          { key: 'reason', header: 'دلیل', cell: (e) => reasonText(e.reason) },
        ]}
      />
    </>
  );
}
