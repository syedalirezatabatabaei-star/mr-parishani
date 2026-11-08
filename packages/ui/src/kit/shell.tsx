import type { ReactNode } from 'react';
import type { LinkComponent } from './desk-model.js';
import { Glyph } from './glyphs.js';
import { faDigits } from './format.js';

/**
 * The frame of every page: a skip link, the top bar, the main content and, on a phone, the
 * bar of shortcuts. `tone` is the visual language (ADR-031): `panel` for the center and
 * internal panels, `patient` for patient pages; `theme` the visitor's light or dark.
 *
 * The top bar (owner 1405/08/10): on a phone ☰ at the start, the name in the middle, search
 * and notices at the end; on a wide screen ☰ and the name, the search field, notices and the
 * profile. The pieces that move (the menu, the search) come from the app, which knows the
 * page it is on, so this stays free of any framework.
 */
export interface AppShellProps {
  readonly tone: 'panel' | 'patient';
  readonly theme?: 'light' | 'dark';
  /** The product name as a link home, from the app. */
  readonly brand: ReactNode;
  /** A shorter name for the middle of a phone's bar; the brand if none. */
  readonly shortBrand?: ReactNode;
  /** The ☰ button and its drawer (`ShellMenu`). */
  readonly menu?: ReactNode;
  /** The search field of a wide screen. */
  readonly search?: ReactNode;
  /** The search button of a phone. */
  readonly mobileSearch?: ReactNode;
  /** The bell with its drawer (`InboxBell`, from the app). */
  readonly bell?: ReactNode;
  /** Without a bell: where the notices are, and how many wait. */
  readonly notices?: { readonly href: string; readonly count?: number };
  /** The account's own page, at the bar's end on a wide screen. */
  readonly profile?: { readonly href: string; readonly label: string };
  /** Other actions at the bar's end (signed out: «ورود»). */
  readonly account?: ReactNode;
  /** The shortcuts at the foot of a phone's screen (`BottomBar`). */
  readonly bottomBar?: ReactNode;
  readonly link?: LinkComponent;
  readonly children: ReactNode;
}

const Anchor: LinkComponent = ({ children, ...props }) => <a {...props}>{children}</a>;

export function AppShell({
  tone,
  theme = 'light',
  brand,
  shortBrand,
  menu,
  search,
  mobileSearch,
  bell,
  notices,
  profile,
  account,
  bottomBar,
  link: L = Anchor,
  children,
}: AppShellProps) {
  return (
    <div data-shell="" data-tone={tone} data-theme={theme} className="min-h-dvh bg-canvas text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:p-2"
      >
        رفتن به محتوای اصلی
      </a>
      <header className="sticky top-0 z-20 border-b border-border bg-surface print:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-1 px-2 py-2 lg:gap-4 lg:px-4">
          <div className="flex shrink-0 items-center gap-2">
            {menu}
            <div className={`font-bold ${menu ? 'hidden lg:block' : ''}`}>{brand}</div>
          </div>
          {menu && (
            <div className="min-w-0 flex-1 truncate text-center font-bold lg:hidden">
              {shortBrand ?? brand}
            </div>
          )}
          <div className="hidden min-w-0 flex-1 justify-center lg:flex">{search}</div>
          {!menu && <div className="flex-1 lg:hidden" />}
          <div className="flex shrink-0 items-center gap-1 lg:gap-2">
            {mobileSearch && <span className="lg:hidden">{mobileSearch}</span>}
            {bell}
            {!bell && notices && (
              <L
                href={notices.href}
                aria-label={
                  notices.count
                    ? `اعلان‌ها و کارهای در انتظار، ${faDigits(notices.count)} مورد`
                    : 'اعلان‌ها و کارهای در انتظار'
                }
                className="relative grid size-11 place-items-center rounded-md text-ink hover:bg-sunken"
              >
                <Glyph name="bell" />
                {notices.count ? (
                  <span
                    aria-hidden="true"
                    className="figures absolute top-1 end-1 min-w-4 rounded-full bg-highlight px-1 text-center text-[0.625rem] leading-4 font-bold text-on-highlight"
                  >
                    {faDigits(notices.count > 99 ? '99+' : notices.count)}
                  </span>
                ) : null}
              </L>
            )}
            {profile && (
              <L
                href={profile.href}
                aria-label={`حساب من: ${profile.label}`}
                className="hidden min-h-10 items-center gap-2 rounded-full border border-border px-2 ps-1 text-[length:var(--text-sm)] hover:bg-sunken lg:flex"
              >
                <span className="grid size-8 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
                  <Glyph name="user" className="size-5" />
                </span>
                <span className="max-w-40 truncate">{profile.label}</span>
              </L>
            )}
            {account && <div className="flex flex-wrap items-center gap-2">{account}</div>}
          </div>
        </div>
      </header>
      <main
        id="main"
        className={`mx-auto max-w-6xl space-y-6 px-4 py-6 print:max-w-none print:p-0 ${bottomBar ? 'pb-[calc(7rem+env(safe-area-inset-bottom))] lg:pb-6' : ''}`}
      >
        {children}
      </main>
      {bottomBar}
    </div>
  );
}

/** A navigation link's classes; `current` marks the page you are on. */
export const navLinkClass = (current: boolean) =>
  `inline-flex min-h-10 items-center rounded-md px-3 whitespace-nowrap ${
    current ? 'bg-accent-soft font-medium text-on-accent-soft' : 'text-ink-muted hover:bg-sunken'
  }`;

/** A page's heading row: the title and, at its end, the page's main actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-[length:var(--text-xl)] font-bold">{title}</h1>
        {description && (
          <p className="text-[length:var(--text-sm)] text-ink-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
