'use client';

import { useEffect, useId, useState } from 'react';
import { searchItems, TILE_CLASS, type DeskItem, type LinkComponent } from './desk-model.js';
import { faDigits } from './format.js';
import { Glyph } from './glyphs.js';
import { openMenu } from './menu.js';

/*
 * The desk's own client parts (owner 1405/08/10), apart from the menu so that a page without
 * the desk or the top search does not load them (the patient pages' JavaScript budget).
 */

const Anchor: LinkComponent = ({ children, ...props }) => <a {...props}>{children}</a>;

/**
 * The search of the top bar: a patient's goes to the doctor search (a form); staff find a
 * service of their own by name, listed under the field.
 */
export function ServiceSearch({
  items,
  link: L = Anchor,
}: {
  items: readonly DeskItem[];
  link?: LinkComponent;
}) {
  const [query, setQuery] = useState('');
  const id = useId();
  const found = searchItems(items, query).slice(0, 8);
  return (
    <div className="relative w-full max-w-md">
      <label htmlFor={id} className="sr-only">
        جستجوی خدمات
      </label>
      <input
        id={id}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setQuery('');
        }}
        placeholder="جستجوی خدمات…"
        // Points at the list only while it is there (axe: aria-valid-attr-value).
        aria-controls={query.trim() ? `${id}-list` : undefined}
        className="min-h-10 w-full rounded-full border border-border bg-sunken ps-10 pe-4 text-ink placeholder:text-ink-subtle"
      />
      <Glyph
        name="search"
        className="pointer-events-none absolute start-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-subtle"
      />
      {query.trim() && (
        <ul
          id={`${id}-list`}
          aria-label="نتیجه جستجو"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {found.length === 0 ? (
            <li className="p-2 text-[length:var(--text-sm)] text-ink-muted">
              خدمتی با این نام پیدا نشد.
            </li>
          ) : (
            found.map((item) => (
              <li key={item.href}>
                <L
                  href={item.href}
                  onClick={() => {
                    setQuery('');
                  }}
                  className="flex min-h-10 items-center gap-3 rounded-md px-2 hover:bg-sunken"
                >
                  <span
                    className={`grid size-7 place-items-center rounded-md text-white ${TILE_CLASS[item.color]}`}
                  >
                    <Glyph name={item.glyph} className="size-4" />
                  </span>
                  {item.label}
                </L>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** «همه خدمات»: the desk's last tile, opening the menu with every service. */
export function AllServicesTile() {
  return (
    <button
      type="button"
      onClick={() => {
        openMenu(false);
      }}
      className="group flex w-full flex-col items-center gap-1.5 rounded-lg p-1 text-center lg:items-start lg:gap-2 lg:border lg:border-dashed lg:border-border-strong lg:p-3 lg:text-start"
    >
      <span className="grid size-14 place-items-center rounded-2xl border-2 border-dashed border-border-strong text-ink-muted lg:size-12">
        <Glyph name="grid" className="size-7" />
      </span>
      <span className="text-[length:var(--text-xs)] leading-tight font-medium text-ink lg:text-[length:var(--text-sm)] lg:font-bold">
        همه خدمات
      </span>
      <span className="hidden text-[length:var(--text-xs)] text-ink-muted lg:line-clamp-2">
        همه بخش‌هایی که به آن‌ها دسترسی دارید، گروه‌به‌گروه.
      </span>
    </button>
  );
}

export type BannerTone = 'accent' | 'highlight' | 'indigo' | 'teal' | 'rose' | 'amber';

export interface BannerSlide {
  readonly title: string;
  readonly text: string;
  readonly href?: string | undefined;
  readonly linkLabel?: string | undefined;
  /** The background: the tone's own colors, or a group color with white text. */
  readonly tone?: BannerTone | undefined;
  /** A picture beside the text, served by the app's own origin. */
  readonly imageUrl?: string | undefined;
  /** How long this slide stays, in seconds; 6 when not set. */
  readonly seconds?: number | undefined;
}

const BANNER_TONE: Readonly<Record<BannerTone, string>> = {
  accent: 'bg-accent text-on-accent',
  highlight: 'bg-highlight text-on-highlight',
  indigo: 'bg-tile-indigo text-white',
  teal: 'bg-tile-teal text-white',
  rose: 'bg-tile-rose text-white',
  amber: 'bg-tile-amber text-white',
};

/**
 * A small turning banner of notices (owner 1405/08/10): its slides from the database, each
 * with its tone, picture and time. It stops under the pointer or the focus, and never turns
 * for who asked for less motion (WCAG 2.2.2); the dots choose a slide.
 */
export function DeskBanner({
  slides,
  link: L = Anchor,
}: {
  slides: readonly BannerSlide[];
  link?: LinkComponent;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const seconds = slides[index % Math.max(slides.length, 1)]?.seconds ?? 6;
  useEffect(() => {
    if (paused || slides.length < 2) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setTimeout(() => {
      setIndex((i) => (i + 1) % slides.length);
    }, seconds * 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [paused, slides.length, index, seconds]);
  const slide = slides[index % Math.max(slides.length, 1)];
  if (!slide) return null;
  return (
    <section
      aria-roledescription="اسلاید"
      aria-label="اطلاعیه‌ها"
      onMouseEnter={() => {
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
      }}
      onFocus={() => {
        setPaused(true);
      }}
      onBlur={() => {
        setPaused(false);
      }}
      className={`relative overflow-hidden rounded-lg p-4 transition-colors lg:px-8 lg:py-6 ${BANNER_TONE[slide.tone ?? 'accent']}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -end-6 -top-10 size-40 rounded-full bg-current opacity-10"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-12 end-24 size-28 rounded-full bg-current opacity-10"
      />
      <div className="relative flex items-center gap-4">
        <div aria-live={paused ? 'polite' : 'off'} className="min-h-16 flex-1 space-y-1 pe-4">
          <p className="font-bold lg:text-[length:var(--text-lg)]">{slide.title}</p>
          <p className="text-[length:var(--text-sm)] opacity-95">{slide.text}</p>
          {slide.href && (
            <L
              href={slide.href}
              className="inline-block pt-1 text-[length:var(--text-sm)] font-bold underline underline-offset-4"
            >
              {slide.linkLabel ?? 'بیشتر'}
            </L>
          )}
        </div>
        {slide.imageUrl && (
          <img
            src={slide.imageUrl}
            alt=""
            className="size-20 shrink-0 rounded-lg object-cover lg:h-28 lg:w-44"
          />
        )}
      </div>
      {slides.length > 1 && (
        <div className="relative mt-1 flex">
          {slides.map((s, i) => (
            <button
              key={`${s.title}-${String(i)}`}
              type="button"
              aria-label={`اطلاعیه ${faDigits(i + 1)} از ${faDigits(slides.length)}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => {
                setIndex(i);
              }}
              className="grid h-6 min-w-6 place-items-center"
            >
              <span
                className={`h-2 rounded-full bg-current transition-[width] ${i === index ? 'w-5' : 'w-2 opacity-50'}`}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
