'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { THEME_COOKIE } from '../tokens.js';
import { CountBadge } from './badge.js';
import {
  currentHref,
  itemName,
  searchItems,
  TILE_CLASS,
  type DeskItem,
  type LinkComponent,
  type MenuGroup,
} from './desk-model.js';
import { faDigits } from './format.js';
import { Glyph } from './glyphs.js';

/** The event that opens the menu from elsewhere on the page («همه خدمات», the search icon). */
const OPEN_MENU = 'sepehr:open-menu';

/** Opens the menu; with `search`, its service search takes the focus. */
export function openMenu(search = false) {
  window.dispatchEvent(new CustomEvent(OPEN_MENU, { detail: { search } }));
}

const Anchor: LinkComponent = ({ children, ...props }) => <a {...props}>{children}</a>;

function MenuLink({
  item,
  current,
  link: L,
  onPick,
}: {
  item: DeskItem;
  current: boolean;
  link: LinkComponent;
  onPick: () => void;
}) {
  return (
    <L
      href={item.href}
      onClick={onPick}
      aria-current={current ? 'page' : undefined}
      aria-label={itemName(item)}
      className={`flex min-h-11 items-center gap-3 rounded-md px-2 ${
        current ? 'bg-accent-soft font-medium text-on-accent-soft' : 'text-ink hover:bg-sunken'
      }`}
    >
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-[0.6rem] text-white ${TILE_CLASS[item.color]}`}
      >
        <Glyph name={item.glyph} className="size-[1.1rem]" />
      </span>
      <span className="flex-1">{item.label}</span>
      {item.isNew && (
        <span className="rounded-full bg-accent-soft px-2 text-[length:var(--text-xs)] text-on-accent-soft">
          جدید
        </span>
      )}
      {item.count ? <CountBadge count={item.count} /> : null}
    </L>
  );
}

/** Light or dark, kept in a cookie so the server draws the next page the same way. */
function ThemeSwitch({ initial }: { initial: 'light' | 'dark' }) {
  const [theme, setTheme] = useState(initial);
  const ref = useRef<HTMLButtonElement>(null);
  const dark = theme === 'dark';
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    setTheme(next);
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    ref.current?.closest('[data-shell]')?.setAttribute('data-theme', next);
  };
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={dark}
      onClick={toggle}
      className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-ink hover:bg-sunken"
    >
      <span className="grid size-8 place-items-center rounded-[0.6rem] bg-sunken text-ink">
        <Glyph name={dark ? 'moon' : 'sun'} className="size-[1.1rem]" />
      </span>
      <span className="flex-1 text-start">حالت تیره</span>
      <span
        aria-hidden="true"
        className={`relative h-6 w-10 rounded-full transition-colors ${dark ? 'bg-accent' : 'bg-border-strong'}`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-surface transition-[inset-inline-start] ${dark ? 'start-[1.125rem]' : 'start-0.5'}`}
        />
      </span>
    </button>
  );
}

export interface ShellMenuProps {
  /** The menu's name for screen readers, such as «بخش‌های پنل داخلی». */
  readonly label: string;
  readonly groups: readonly MenuGroup[];
  readonly home: { readonly href: string; readonly label: string };
  readonly currentPath: string;
  /** Who is signed in: a role, or «بیمار»; and a line under it (the mobile's last digits). */
  readonly user?: { readonly title: string; readonly subtitle?: string };
  /** Under the account: the patient's club, for one. */
  readonly extra?: ReactNode;
  readonly about: ReactNode;
  readonly version: string;
  readonly theme: 'light' | 'dark';
  readonly logout?: ReactNode;
  readonly link?: LinkComponent;
}

/**
 * The ☰ button and the side drawer it opens (owner 1405/08/10), on every screen: the account,
 * a search of the services, every service the account may use in its groups, the theme,
 * about, the version and sign-out. A modal `<dialog>`: Escape closes it and focus stays in it.
 */
export function ShellMenu({
  label,
  groups,
  home,
  currentPath,
  user,
  extra,
  about,
  version,
  theme,
  logout,
  link = Anchor,
}: ShellMenuProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const titleId = useId();
  const all = groups.flatMap((g) => g.items);
  const current = currentHref([home.href, ...all.map((i) => i.href)], currentPath, home.href);
  const found = searchItems(all, query);

  const open = (focusSearch: boolean) => {
    const d = dialog.current;
    if (!d) return;
    if (!d.open) d.showModal();
    if (focusSearch) search.current?.focus();
  };
  const close = () => {
    dialog.current?.close();
    setQuery('');
  };

  useEffect(() => {
    const onOpen = (e: Event) => {
      open((e as CustomEvent<{ search: boolean }>).detail.search);
    };
    window.addEventListener(OPEN_MENU, onOpen);
    return () => {
      window.removeEventListener(OPEN_MENU, onOpen);
    };
  }, []);

  const L = link;
  return (
    <>
      <button
        type="button"
        aria-label="منو"
        aria-haspopup="dialog"
        onClick={() => {
          open(false);
        }}
        className="grid size-11 place-items-center rounded-md text-ink hover:bg-sunken"
      >
        <Glyph name="menu" />
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={() => {
          setQuery('');
        }}
        onClick={(e) => {
          // A click on the backdrop (the dialog itself, outside its panel) closes it.
          if (e.target === e.currentTarget) close();
        }}
        className="fixed inset-y-0 start-0 end-auto m-0 h-dvh max-h-none w-[min(21rem,88vw)] max-w-none overflow-hidden bg-surface p-0 text-ink shadow-lg backdrop:bg-black/40 open:flex open:flex-col"
      >
        <div className="flex items-center gap-3 border-b border-border p-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
            <Glyph name="user" className="size-7" />
          </span>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="truncate font-bold">
              {user?.title ?? 'منو'}
            </p>
            {user?.subtitle && (
              <p className="figures truncate text-[length:var(--text-sm)] text-ink-muted">
                {user.subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="بستن منو"
            onClick={close}
            className="grid size-10 place-items-center rounded-md text-ink-muted hover:bg-sunken"
          >
            <Glyph name="close" className="size-5" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-3">
          {extra}
          <div className="relative">
            <label htmlFor={`${titleId}-q`} className="sr-only">
              جستجوی خدمات
            </label>
            <input
              ref={search}
              id={`${titleId}-q`}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="جستجوی خدمات…"
              className="min-h-11 w-full rounded-md border border-border-strong bg-surface ps-10 pe-3 text-ink placeholder:text-ink-subtle"
            />
            <Glyph
              name="search"
              className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-ink-subtle"
            />
          </div>
          {query.trim() ? (
            <section aria-label="نتیجه جستجو">
              {found.length === 0 ? (
                <p className="px-2 text-[length:var(--text-sm)] text-ink-muted">
                  خدمتی با این نام پیدا نشد.
                </p>
              ) : (
                <ul className="space-y-1">
                  {found.map((item) => (
                    <li key={item.href}>
                      <MenuLink
                        item={item}
                        current={current === item.href}
                        link={L}
                        onPick={close}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <nav aria-label={label} className="space-y-4">
              <ul>
                <li>
                  <L
                    href={home.href}
                    onClick={close}
                    aria-current={current === home.href ? 'page' : undefined}
                    className={`flex min-h-11 items-center gap-3 rounded-md px-2 ${
                      current === home.href
                        ? 'bg-accent-soft font-medium text-on-accent-soft'
                        : 'text-ink hover:bg-sunken'
                    }`}
                  >
                    <span className="grid size-8 place-items-center rounded-[0.6rem] bg-accent text-on-accent">
                      <Glyph name="home" className="size-[1.1rem]" />
                    </span>
                    {home.label}
                  </L>
                </li>
              </ul>
              {groups.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <h2 className="px-2 pb-1 text-[length:var(--text-xs)] font-bold text-ink-subtle">
                    {g.label}
                  </h2>
                  <ul className="space-y-0.5">
                    {g.items.map((item) => (
                      <li key={item.href}>
                        <MenuLink
                          item={item}
                          current={current === item.href}
                          link={L}
                          onPick={close}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
          )}
          <div className="space-y-1 border-t border-border pt-3">
            <ThemeSwitch initial={theme} />
            <details className="rounded-md px-2 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3">
                <span className="grid size-8 place-items-center rounded-[0.6rem] bg-sunken text-ink">
                  <Glyph name="info" className="size-[1.1rem]" />
                </span>
                درباره سپهر سلامتی
              </summary>
              <div className="space-y-2 pb-2 text-[length:var(--text-sm)] text-ink-muted">
                {about}
              </div>
            </details>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border p-3">
          <span className="figures text-[length:var(--text-xs)] text-ink-subtle">
            نسخه {faDigits(version)}
          </span>
          {logout}
        </div>
      </dialog>
    </>
  );
}

/** A button that opens the menu with its search: the top bar's search on a phone. */
export function MenuSearchButton() {
  return (
    <button
      type="button"
      aria-label="جستجو"
      onClick={() => {
        openMenu(true);
      }}
      className="grid size-11 place-items-center rounded-md text-ink hover:bg-sunken"
    >
      <Glyph name="search" />
    </button>
  );
}

/**
 * The bar of shortcuts at the foot of a phone's screen (owner 1405/08/10): home and the
 * account's most used services. Gone on a wide screen.
 */
export function BottomBar({
  home,
  items,
  currentPath,
  link: L = Anchor,
}: {
  home: { href: string; label: string };
  items: readonly DeskItem[];
  currentPath: string;
  link?: LinkComponent;
}) {
  const all = [
    {
      href: home.href,
      label: home.label,
      shortLabel: home.label,
      glyph: 'home' as const,
      count: 0,
    },
    ...items,
  ];
  const current = currentHref(
    all.map((i) => i.href),
    currentPath,
    home.href,
  );
  return (
    <nav
      aria-label="میانبرها"
      className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-20 rounded-2xl border border-border bg-surface shadow-lg lg:hidden print:hidden"
    >
      {/* Equal shares, none wider than its share; a label never cut, two lines at most. */}
      <ul className="flex">
        {all.map((item) => {
          const here = current === item.href;
          return (
            <li key={item.href} className="min-w-0 flex-1">
              <L
                href={item.href}
                aria-current={here ? 'page' : undefined}
                aria-label={item.label}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-[0.6875rem] leading-tight ${
                  here ? 'font-bold text-accent' : 'text-ink-muted'
                }`}
              >
                <Glyph name={item.glyph} className="size-6 shrink-0" />
                <span data-short-label="" className="max-w-full text-center break-words">
                  {item.shortLabel ?? item.label}
                </span>
                {item.count ? (
                  <CountBadge count={item.count} className="absolute top-1 start-[55%]" />
                ) : null}
              </L>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
