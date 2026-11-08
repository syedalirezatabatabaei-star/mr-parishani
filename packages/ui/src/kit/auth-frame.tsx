import type { ReactNode } from 'react';
import { Glyph, type GlyphName } from './glyphs.js';

/**
 * Sepehr's mark (owner 1405/08/10): an eight-pointed star in a ring, «sepehr» being the sky,
 * drawn for us; nothing borrowed, nothing fetched (rule 19).
 */
export function SepehrMark({ className = 'size-10' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false" className={className}>
      <circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth="2.5" />
      <path
        d="M24 9.5 28.2 15l6.6-.9-.9 6.7L39.5 24l-5.6 3.3.9 6.6-6.6-.9L24 38.5 19.8 33l-6.6.9.9-6.6L8.5 24l5.6-3.2-.9-6.7 6.6.9L24 9.5Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
      <circle cx="24" cy="24" r="4.5" className="fill-accent" />
    </svg>
  );
}

/** A quiet tiling of eight-pointed stars, behind the brand side (decorative). */
function StarTiling() {
  return (
    <svg aria-hidden="true" focusable="false" className="absolute inset-0 size-full">
      <defs>
        <pattern id="sepehr-tiling" width="64" height="64" patternUnits="userSpaceOnUse">
          <path
            d="M32 14 36 24l10-4-4 10 10 4-10 4 4 10-10-4-4 10-4-10-10 4 4-10-10-4 10-4-4-10 10 4 4-10Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle cx="0" cy="0" r="3" fill="currentColor" />
          <circle cx="64" cy="64" r="3" fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#sepehr-tiling)" />
    </svg>
  );
}

export interface AuthPoint {
  readonly glyph: GlyphName;
  readonly title: string;
  readonly text: string;
}

export interface AuthFrameProps {
  readonly tone: 'panel' | 'patient';
  /** Which door this is: «پنل داخلی», «پنل مراکز و پزشکان». */
  readonly area: string;
  readonly title: string;
  readonly lead?: string;
  /** The brand side's heading and its points, on a wide screen. */
  readonly heading: string;
  readonly points: readonly AuthPoint[];
  /** Under the form: help, and other ways in. */
  readonly footer?: ReactNode;
  /** The chip's glyph above the title; a lock for a sign-in. */
  readonly badge?: GlyphName;
  /** A longer form (a request) gets a wider card. */
  readonly wide?: boolean;
  /** The visitor's light or dark (the `THEME_COOKIE`). */
  readonly theme?: 'light' | 'dark';
  readonly children: ReactNode;
}

/**
 * The frame of a sign-in page (owner 1405/08/10): the brand side in the tone's color with
 * what the place is for, and the form on a card. On a phone the brand is a band above the
 * card. The form itself is the app's (`StaffLogin`), unchanged.
 */
export function AuthFrame({
  tone,
  area,
  title,
  lead,
  heading,
  points,
  footer,
  badge = 'lock',
  wide = false,
  theme = 'light',
  children,
}: AuthFrameProps) {
  return (
    <div
      data-tone={tone}
      data-theme={theme}
      className="min-h-dvh bg-canvas text-ink lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:p-2"
      >
        رفتن به محتوای اصلی
      </a>
      <section
        aria-label="سپهر سلامتی"
        className="flex flex-col overflow-hidden bg-accent max-lg:relative px-6 pt-8 pb-16 text-on-accent lg:sticky lg:top-0 lg:h-dvh lg:px-12 lg:py-12"
      >
        <span className="text-on-accent opacity-[0.09]">
          <StarTiling />
        </span>
        <div className="relative flex items-center gap-3">
          <SepehrMark className="size-12 shrink-0" />
          <div>
            <p className="text-[length:var(--text-lg)] font-extrabold">سپهر سلامتی</p>
            <p className="text-[length:var(--text-sm)] opacity-90">{area}</p>
          </div>
        </div>
        <div className="relative mt-auto hidden max-w-md space-y-8 pt-16 lg:block">
          <p className="text-[length:var(--text-2xl)] leading-snug font-extrabold">{heading}</p>
          <ul className="space-y-5">
            {points.map((p) => (
              <li key={p.title} className="flex gap-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-on-accent/15 ring-1 ring-on-accent/25">
                  <Glyph name={p.glyph} className="size-6" />
                </span>
                <span className="space-y-0.5">
                  <span className="block font-bold">{p.title}</span>
                  <span className="block text-[length:var(--text-sm)] opacity-90">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 hidden text-[length:var(--text-xs)] opacity-80 lg:block">
          وام‌دهنده و طرف قراردادها: شرکت آرامش ثروت
        </p>
      </section>
      <main
        id="main"
        className={`relative -mt-10 flex justify-center px-4 pb-10 lg:mt-0 lg:py-12 ${wide ? '' : 'lg:items-center'}`}
      >
        <div
          className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} space-y-6 rounded-lg border border-border bg-surface p-6 shadow-lg sm:p-8`}
        >
          <div className="space-y-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[length:var(--text-xs)] font-medium text-on-accent-soft">
              <Glyph name={badge} className="size-3.5" />
              {area}
            </span>
            <h1 className="text-[length:var(--text-xl)] font-bold">{title}</h1>
            {lead && <p className="text-[length:var(--text-sm)] text-ink-muted">{lead}</p>}
          </div>
          {children}
          {footer && (
            <div className="space-y-2 border-t border-border pt-4 text-[length:var(--text-sm)] text-ink-muted">
              {footer}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** The text pages' addresses on the patient site (owner 1405/08/10). */
export const CONTENT_PAGES = [
  { slug: 'about', title: 'درباره سپهر سلامتی' },
  { slug: 'terms', title: 'قوانین و شرایط' },
  { slug: 'privacy', title: 'حریم خصوصی' },
  { slug: 'contact', title: 'تماس با ما' },
  { slug: 'help', title: 'راهنما' },
  { slug: 'faq', title: 'پرسش‌های متداول' },
] as const;

/**
 * The menu's «درباره» part: the text pages, at `origin` (the patient site's, from the internal
 * panel; empty on the site itself).
 */
export function ContentPageLinks({ origin = '' }: { origin?: string }) {
  return (
    <ul className="space-y-1">
      {CONTENT_PAGES.map((p) => (
        <li key={p.slug}>
          <a
            href={`${origin}/pages/${p.slug}`}
            className="inline-flex min-h-9 items-center text-accent underline-offset-4 hover:underline"
          >
            {p.title}
          </a>
        </li>
      ))}
    </ul>
  );
}
