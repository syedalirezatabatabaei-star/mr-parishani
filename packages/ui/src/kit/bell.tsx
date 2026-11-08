'use client';

import { unwrap } from '@sepehr/api-client';
import type { Inbox, InboxItem } from '@sepehr/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../app/browser-api.js';
import type { LinkComponent } from './desk-model.js';
import { faDigits, showInstant } from './format.js';
import { Glyph } from './glyphs.js';

const Anchor: LinkComponent = ({ children, ...props }) => <a {...props}>{children}</a>;
/** How often the count is read again while the page stays open. */
const REFRESH_MS = 60_000;

/**
 * The bell (owner 1405/08/10): the account's own notifications and the announcements for it,
 * the unread count on the button, a drawer listing them; an item opened or marked is read.
 * Texts are the API's, generic; never an amount or an identifier.
 */
export function InboxBell({ link: L = Anchor }: { link?: LinkComponent }) {
  const api = useApi();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failed, setFailed] = useState(false);

  /** The list as the API has it now; null when it cannot be read. */
  const fetchInbox = useCallback(async (): Promise<Inbox | null> => {
    try {
      return await unwrap(api.GET('/api/v1/me/inbox'));
    } catch {
      return null;
    }
  }, [api]);

  const show = (next: Inbox | null) => {
    setFailed(next === null);
    if (next) setInbox(next);
  };

  const load = async () => {
    show(await fetchInbox());
  };

  useEffect(() => {
    let live = true;
    const refresh = () => {
      void fetchInbox().then((next) => {
        if (live) show(next);
      });
    };
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [fetchInbox]);

  const read = async (body: { all: true } | { ids: string[] }) => {
    try {
      await unwrap(api.POST('/api/v1/me/inbox/read', { body }));
    } finally {
      await load();
    }
  };

  const unread = inbox?.unread ?? 0;
  const open = () => {
    void load();
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  };
  const close = () => dialog.current?.close();

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={unread ? `اعلان‌ها، ${faDigits(unread)} خوانده‌نشده` : 'اعلان‌ها'}
        onClick={open}
        className="relative grid size-11 place-items-center rounded-md text-ink hover:bg-sunken"
      >
        <Glyph name="bell" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="figures absolute end-1 top-1 min-w-4 rounded-full bg-highlight px-1 text-center text-[0.625rem] leading-4 font-bold text-on-highlight"
          >
            {faDigits(unread > 99 ? '99+' : unread)}
          </span>
        )}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        className="fixed inset-y-0 start-auto end-0 m-0 h-dvh max-h-none w-[min(24rem,92vw)] max-w-none overflow-hidden bg-surface p-0 text-ink shadow-lg backdrop:bg-black/40 open:flex open:flex-col"
      >
        <div className="flex items-center gap-2 border-b border-border p-4">
          <h2 id={titleId} className="flex-1 font-bold">
            اعلان‌ها
          </h2>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => {
                void read({ all: true });
              }}
              className="min-h-10 rounded-md px-2 text-[length:var(--text-sm)] font-medium text-accent hover:bg-sunken"
            >
              همه خوانده شد
            </button>
          )}
          <button
            type="button"
            aria-label="بستن اعلان‌ها"
            onClick={close}
            className="grid size-10 place-items-center rounded-md text-ink-muted hover:bg-sunken"
          >
            <Glyph name="close" className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {failed ? (
            <p className="p-2 text-[length:var(--text-sm)] text-ink-muted">
              اعلان‌ها خوانده نشد؛ کمی بعد دوباره بازکنید.
            </p>
          ) : !inbox || inbox.items.length === 0 ? (
            <p className="p-2 text-[length:var(--text-sm)] text-ink-muted">اعلانی ندارید.</p>
          ) : (
            <ul aria-label="فهرست اعلان‌ها" className="space-y-2">
              {inbox.items.map((item) => (
                <li key={item.id}>
                  <Item item={item} link={L} onRead={(ids) => read({ ids })} onGo={close} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </dialog>
    </>
  );
}

function Item({
  item,
  link: L,
  onRead,
  onGo,
}: {
  item: InboxItem;
  link: LinkComponent;
  onRead: (ids: string[]) => Promise<void>;
  onGo: () => void;
}) {
  const body = (
    <>
      <span className="flex items-center gap-2">
        {!item.read && (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-highlight" />
        )}
        <span className="flex-1 font-bold">{item.title}</span>
        {item.urgent && (
          <span className="rounded-full bg-danger-soft px-2 text-[length:var(--text-xs)] font-bold text-danger">
            فوری
          </span>
        )}
      </span>
      <span className="block text-[length:var(--text-sm)] text-ink-muted">{item.body}</span>
      <span className="figures block text-[length:var(--text-xs)] text-ink-subtle">
        {item.source === 'announcement' ? 'اطلاعیه · ' : ''}
        {showInstant(item.createdAt)}
        {item.read ? '' : ' · خوانده‌نشده'}
      </span>
    </>
  );
  const box = `block w-full space-y-1 rounded-md border p-3 text-start ${
    item.read ? 'border-border' : 'border-accent bg-accent-soft/40'
  }`;
  if (item.linkHref) {
    return (
      <L
        href={item.linkHref}
        className={`${box} hover:bg-sunken`}
        onClick={() => {
          void onRead([item.id]);
          onGo();
        }}
      >
        {body}
      </L>
    );
  }
  return (
    <div className={box}>
      {body}
      {!item.read && (
        <button
          type="button"
          onClick={() => {
            void onRead([item.id]);
          }}
          className="mt-1 min-h-9 rounded-md px-2 text-[length:var(--text-sm)] font-medium text-accent hover:bg-sunken"
        >
          خوانده شد
        </button>
      )}
    </div>
  );
}
