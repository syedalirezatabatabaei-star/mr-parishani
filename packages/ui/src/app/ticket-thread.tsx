import type { TicketView } from '@sepehr/contracts';
import type { ReactNode } from 'react';
import { StatusBadge } from '../kit/controls.js';
import { faDigits, showInstant } from '../kit/format.js';
import { TICKET_LINK } from './phase7-labels.js';

type Message = TicketView['messages'][number];
type Attachment = TicketView['attachments'][number];

const SIDE: Readonly<Record<Message['side'], string>> = {
  requester: 'ثبت‌کننده',
  staff: 'کارشناس',
  respondent: 'پاسخ پزشک',
};

export interface TicketThreadProps {
  readonly messages: readonly Message[];
  readonly attachments: readonly Attachment[];
  readonly links: TicketView['links'];
  /**
   * Who reads. A requester's or respondent's own side is «شما»; staff are many, so in their
   * view a staff message stays «کارشناس», never «شما».
   */
  readonly reader: Message['side'];
  /** A file's open button (a short-lived signed link, rule 28): the page's own client part. */
  readonly openAttachment?: (attachment: Attachment) => ReactNode;
  /** Staff only: the after-the-fact treatment mark of a message (task 7-2). */
  readonly messageAction?: (message: Message) => ReactNode;
}

const kb = (bytes: number) => `${faDigits(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت`;

/**
 * A ticket's conversation (task 7-7; doc 17 §1): oldest first, each message with its side and
 * time, its digits shown Persian (stored Latin, rule 23). An internal note is labeled as one; the requester's view never has one at all (the
 * API leaves it out, test 3), so nothing here decides who sees what.
 */
export function TicketThread({
  messages,
  attachments,
  links,
  reader,
  openAttachment,
  messageAction,
}: TicketThreadProps) {
  const loose = attachments.filter((a) => a.messageId === null);
  return (
    <div className="space-y-4">
      {links.length > 0 && (
        <section aria-labelledby="ticket-links" className="space-y-2">
          <h2 id="ticket-links" className="font-bold text-ink">
            پیوندها
          </h2>
          <ul className="flex flex-wrap gap-2 text-[length:var(--text-sm)]">
            {links.map((l) => (
              <li
                key={`${l.type}:${l.id}`}
                className="rounded-md border border-border bg-surface px-2 py-1"
              >
                {TICKET_LINK[l.type]}: {l.label}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="ticket-thread" className="space-y-2">
        <h2 id="ticket-thread" className="font-bold text-ink">
          گفتگو
        </h2>
        <ol className="space-y-3">
          {messages.map((m) => {
            const internal = m.visibility === 'internal';
            const files = attachments.filter((a) => a.messageId === m.id);
            const own = reader !== 'staff' && m.side === reader;
            return (
              <li
                key={m.id}
                className={`rounded-lg border p-3 ${
                  internal
                    ? 'border-dashed border-warning bg-warning-soft'
                    : own
                      ? 'border-border-strong bg-sunken'
                      : 'border-border bg-surface'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-sm)] text-ink-muted">
                  <span className="font-bold text-ink">{own ? 'شما' : SIDE[m.side]}</span>
                  <span>{showInstant(m.createdAt)}</span>
                  {internal && <StatusBadge tone="warning">یادداشت داخلی</StatusBadge>}
                  {m.containsTreatment === true && (
                    <StatusBadge tone="info">حاوی اطلاعات درمان</StatusBadge>
                  )}
                  {messageAction?.(m)}
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-ink">{faDigits(m.body)}</p>
                {files.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {files.map((f) => (
                      <li key={f.id}>{openAttachment?.(f)}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      </section>
      {loose.length > 0 && (
        <section aria-labelledby="ticket-files" className="space-y-2">
          <h2 id="ticket-files" className="font-bold text-ink">
            پیوست‌ها
          </h2>
          <ul className="space-y-2">
            {loose.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-2 text-[length:var(--text-sm)]"
              >
                {openAttachment?.(a)}
                <span className="text-ink-subtle">
                  {kb(a.sizeBytes)}، {showInstant(a.createdAt)}
                </span>
                {a.containsTreatment && <StatusBadge tone="info">حاوی اطلاعات درمان</StatusBadge>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * A ticket's deadline as its reader needs it (doc 17 §1): the time, «past» once it has
 * passed, and «stopped» while it waits on the requester (that time is not counted).
 */
export function TicketDeadline({
  dueAt,
  paused,
  now,
}: {
  dueAt: string | null;
  paused: boolean;
  now: Date;
}) {
  if (dueAt === null) return <span className="text-ink-subtle">بی مهلت</span>;
  if (paused) return <StatusBadge tone="neutral">متوقف تا پاسخ ثبت‌کننده</StatusBadge>;
  return new Date(dueAt).getTime() < now.getTime() ? (
    <StatusBadge tone="danger">گذشته از مهلت: {showInstant(dueAt)}</StatusBadge>
  ) : (
    <span>{showInstant(dueAt)}</span>
  );
}
