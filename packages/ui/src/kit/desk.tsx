import type { ReactNode } from 'react';
import { CountBadge } from './badge.js';
import { itemName, TILE_CLASS, type DeskItem, type LinkComponent } from './desk-model.js';
import { faDigits } from './format.js';
import { Glyph } from './glyphs.js';
import { AllServicesTile, DeskBanner, type BannerSlide } from './desk-client.js';

const Anchor: LinkComponent = ({ children, ...props }) => <a {...props}>{children}</a>;

/** On a phone the desk shows this many services, then «همه خدمات»; a wide screen shows all. */
export const PHONE_TILES = 11;

function Tile({
  item,
  link: L,
  phoneHidden,
}: {
  item: DeskItem;
  link: LinkComponent;
  phoneHidden: boolean;
}) {
  return (
    <li className={phoneHidden ? 'max-lg:hidden' : undefined}>
      <L
        href={item.href}
        aria-label={itemName(item)}
        className="group flex h-full flex-col items-center gap-1.5 rounded-lg p-1 text-center hover:bg-sunken lg:items-start lg:gap-2 lg:border lg:border-border lg:bg-surface lg:p-3 lg:text-start lg:shadow-sm lg:hover:border-accent lg:hover:bg-surface"
      >
        <span
          className={`relative grid size-14 place-items-center rounded-2xl text-white shadow-sm lg:size-12 ${TILE_CLASS[item.color]}`}
        >
          <Glyph name={item.glyph} className="size-7" />
          {item.count ? (
            <CountBadge
              count={item.count}
              className="absolute -top-1.5 -end-1.5 ring-2 ring-canvas lg:ring-surface"
            />
          ) : null}
          {item.isNew && (
            <span className="absolute -bottom-1.5 rounded-full bg-highlight px-1.5 text-[0.625rem] leading-4 font-bold text-on-highlight ring-2 ring-canvas lg:ring-surface">
              جدید
            </span>
          )}
        </span>
        <span className="text-[length:var(--text-xs)] leading-tight font-medium text-ink lg:text-[length:var(--text-sm)] lg:font-bold">
          {item.label}
        </span>
        {item.description && (
          <span className="hidden text-[length:var(--text-xs)] leading-normal text-ink-muted lg:line-clamp-2">
            {item.description}
          </span>
        )}
      </L>
    </li>
  );
}

function AsideCard({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      aria-label={id ? undefined : title}
      className="scroll-mt-20 space-y-2 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={id ? `${id}-title` : undefined} className="font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export interface ServiceDeskProps {
  /** The page's heading, such as «پیشخوان». */
  readonly title: string;
  /** A line under it: who it is for. */
  readonly greeting?: string;
  readonly items: readonly DeskItem[];
  readonly slides: readonly BannerSlide[];
  /** A role's dashboard in brief, above the services (the CEO's, a center's). */
  readonly summary?: ReactNode;
  /** The shortcuts, listed in the side column of a wide screen. */
  readonly shortcuts: readonly DeskItem[];
  /** When the account may use nothing yet. */
  readonly empty?: ReactNode;
  readonly link?: LinkComponent;
}

/**
 * The start page of every role (owner 1405/08/10): a service desk of colored tiles. A phone
 * gets the banner, four tiles a row and «همه خدمات»; a wide screen six larger tiles a row
 * with a short line each, and a side column of what waits, the notices and the shortcuts.
 */
export function ServiceDesk({
  title,
  greeting,
  items,
  slides,
  summary,
  shortcuts,
  empty,
  link: L = Anchor,
}: ServiceDeskProps) {
  const waiting = items.filter((i) => i.count);
  return (
    <div className="space-y-5">
      <div className="space-y-0.5">
        <h1 className="text-[length:var(--text-xl)] font-bold">{title}</h1>
        {greeting && <p className="text-[length:var(--text-sm)] text-ink-muted">{greeting}</p>}
      </div>
      {/* The banner is the client's: its links are plain anchors, as no function crosses over. */}
      {slides.length > 0 && <DeskBanner slides={slides} />}
      {summary}
      {items.length === 0 ? (
        empty
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <section aria-label="خدمات" className="min-w-0">
            <ul className="grid grid-cols-4 gap-x-2 gap-y-4 md:grid-cols-6 lg:gap-3">
              {items.map((item, i) => (
                <Tile key={item.href} item={item} link={L} phoneHidden={i >= PHONE_TILES} />
              ))}
              <li>
                <AllServicesTile />
              </li>
            </ul>
          </section>
          <aside className="space-y-4" aria-label="کنار پیشخوان">
            <AsideCard title="در انتظار شما" id="pending">
              {waiting.length === 0 ? (
                <p className="text-[length:var(--text-sm)] text-ink-muted">
                  کار در انتظاری ندارید.
                </p>
              ) : (
                <ul className="space-y-1">
                  {waiting.map((item) => (
                    <li key={item.href}>
                      <L
                        href={item.href}
                        className="flex min-h-10 items-center gap-2 rounded-md px-1 hover:bg-sunken"
                      >
                        <span
                          className={`grid size-7 place-items-center rounded-md text-white ${TILE_CLASS[item.color]}`}
                        >
                          <Glyph name={item.glyph} className="size-4" />
                        </span>
                        <span className="flex-1 text-[length:var(--text-sm)]">{item.label}</span>
                        <span className="figures text-[length:var(--text-sm)] font-bold">
                          {faDigits(item.count ?? 0)}
                        </span>
                      </L>
                    </li>
                  ))}
                </ul>
              )}
            </AsideCard>
            {slides.length > 0 && (
              <AsideCard title="اعلان‌ها">
                <ul className="space-y-2 text-[length:var(--text-sm)]">
                  {slides.map((s) => (
                    <li key={s.title} className="space-y-0.5">
                      <p className="font-medium">{s.title}</p>
                      <p className="text-ink-muted">{s.text}</p>
                    </li>
                  ))}
                </ul>
              </AsideCard>
            )}
            {shortcuts.length > 0 && (
              <AsideCard title="میانبرها">
                <ul className="flex flex-wrap gap-2">
                  {shortcuts.map((item) => (
                    <li key={item.href}>
                      <L
                        href={item.href}
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border px-3 text-[length:var(--text-sm)] hover:border-accent"
                      >
                        <Glyph name={item.glyph} className="size-4 text-accent" />
                        {item.label}
                      </L>
                    </li>
                  ))}
                </ul>
              </AsideCard>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/** A role's dashboard in brief above the desk, linked to the whole of it. */
export function DeskSummary({
  title,
  href,
  children,
  link: L = Anchor,
}: {
  title: string;
  href: string;
  children: ReactNode;
  link?: LinkComponent;
}) {
  return (
    <section
      aria-label={title}
      className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-bold">{title}</h2>
        <L
          href={href}
          className="inline-flex min-h-10 items-center gap-1 text-[length:var(--text-sm)] font-bold text-accent"
        >
          <Glyph name="chart" className="size-4" />
          داشبورد کامل
        </L>
      </div>
      {children}
    </section>
  );
}
