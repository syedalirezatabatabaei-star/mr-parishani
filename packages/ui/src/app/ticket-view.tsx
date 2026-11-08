import type { TicketView } from '@sepehr/contracts';
import { StatusBadge } from '../kit/controls.js';
import { faDigits, showInstant } from '../kit/format.js';
import { TICKET_KIND, TICKET_STATUS } from './phase7-labels.js';
import {
  TicketAttachmentButton,
  TicketReply,
  TicketRequesterActions,
  type TicketSide,
} from './ticket-forms.js';
import { TicketDeadline, TicketThread } from './ticket-thread.js';

const LIVE = new Set(['open', 'assigned', 'in_progress', 'waiting_on_requester', 'reopened']);

/**
 * A ticket as its requester sees it (task 7-7), a patient or a center: the state, the
 * deadline, the conversation and, while it is live, a reply. Once resolved it can be closed
 * or reopened; a financial complaint closes only with its dispute (7-2), so neither is offered
 * then (`canReopen` comes from the API).
 */
export function RequesterTicket({
  side,
  ticket,
  now,
}: {
  side: Exclude<TicketSide, 'staff'>;
  ticket: TicketView;
  now: Date;
}) {
  const live = LIVE.has(ticket.status);
  return (
    <div className="space-y-5">
      <dl className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-3">
        <div>
          <dt className="text-[length:var(--text-sm)] text-ink-muted">وضعیت</dt>
          <dd>
            <StatusBadge tone={TICKET_STATUS[ticket.status].tone}>
              {TICKET_STATUS[ticket.status].label}
            </StatusBadge>
          </dd>
        </div>
        <div>
          <dt className="text-[length:var(--text-sm)] text-ink-muted">ثبت</dt>
          <dd className="figures">{showInstant(ticket.openedAt)}</dd>
        </div>
        <div>
          <dt className="text-[length:var(--text-sm)] text-ink-muted">مهلت پاسخ</dt>
          <dd className="figures">
            <TicketDeadline dueAt={ticket.dueAt} paused={ticket.paused} now={now} />
          </dd>
        </div>
      </dl>
      <TicketThread
        reader="requester"
        messages={ticket.messages}
        attachments={ticket.attachments}
        links={ticket.links}
        openAttachment={(a) => (
          <TicketAttachmentButton
            side={side}
            id={ticket.id}
            attachmentId={a.id}
            label={a.contentType === 'application/pdf' ? 'دریافت PDF' : 'دریافت تصویر'}
          />
        )}
      />
      {live && <TicketReply side={side} id={ticket.id} />}
      <TicketRequesterActions
        side={side}
        id={ticket.id}
        canClose={ticket.status === 'resolved'}
        canReopen={ticket.canReopen}
      />
    </div>
  );
}

/** The heading's words: «شکایت ۱۲: …». */
export const ticketTitle = (t: Pick<TicketView, 'kind' | 'number' | 'subject'>) =>
  `${TICKET_KIND[t.kind]} ${faDigits(t.number)}: ${t.subject}`;
