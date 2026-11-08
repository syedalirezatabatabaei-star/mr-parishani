import type { ComponentType, ReactNode } from 'react';
import type { TileColor } from '../tokens.js';
import { faDigits } from './format.js';
import type { GlyphName } from './glyphs.js';

/**
 * One service of the desk and the menu (owner 1405/08/10): where it goes, its glyph and its
 * group's color. Which services an account sees is the app's (by permission); the API
 * refuses the rest anyway (rule 12).
 */
export interface DeskItem {
  readonly href: string;
  readonly label: string;
  /**
   * The bottom bar's label (owner 1405/08/11): one or two words, at most 12 letters, never cut;
   * the full label stays the link's name for screen readers.
   */
  readonly shortLabel?: string;
  /** A short line under the label, on wide screens. */
  readonly description?: string;
  readonly glyph: GlyphName;
  readonly color: TileColor;
  /** The menu group's label. */
  readonly group: string;
  /** Things waiting, from an API the app already has; none: no counter. */
  readonly count?: number;
  /** A service added lately: marked «جدید». */
  readonly isNew?: boolean;
}

export interface MenuGroup {
  readonly label: string;
  readonly items: readonly DeskItem[];
}

/** The app's link (Next's `Link`), so this package stays free of a framework. */
export type LinkComponent = ComponentType<{
  href: string;
  className?: string | undefined;
  children?: ReactNode;
  onClick?: () => void;
  'aria-current'?: 'page' | undefined;
  'aria-label'?: string | undefined;
}>;

/** The items in their groups, groups in the order first seen, empty groups left out. */
export function groupItems(items: readonly DeskItem[]): MenuGroup[] {
  const groups = new Map<string, DeskItem[]>();
  for (const item of items) {
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }
  return [...groups].map(([label, list]) => ({ label, items: list }));
}

/** Whether `path` is the item's page or under it; home only on itself. */
export function isCurrent(href: string, path: string, home: string): boolean {
  if (href === home) return path === home;
  return path === href || path.startsWith(`${href}/`);
}

/** The item whose page this is: the longest match, so a sub-section wins over its parent. */
export function currentHref(
  hrefs: readonly string[],
  path: string,
  home: string,
): string | undefined {
  return hrefs.filter((h) => isCurrent(h, path, home)).sort((a, b) => b.length - a.length)[0];
}

/** Persian-folded text for a menu search: ی/ي, ک/ك and spaces (rule 23). */
export function foldForSearch(text: string): string {
  return text
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/‌/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The items whose label or description holds every word of the query. */
export function searchItems(items: readonly DeskItem[], query: string): DeskItem[] {
  const words = foldForSearch(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  return items.filter((item) => {
    const text = foldForSearch(`${item.label} ${item.description ?? ''} ${item.group}`);
    return words.every((w) => text.includes(w));
  });
}

/** The class of a tile's colored square, by its group's color (tokens: `--color-tile-*`). */
export const TILE_CLASS: Readonly<Record<TileColor, string>> = {
  indigo: 'bg-tile-indigo',
  teal: 'bg-tile-teal',
  orange: 'bg-tile-orange',
  rose: 'bg-tile-rose',
  green: 'bg-tile-green',
  blue: 'bg-tile-blue',
  purple: 'bg-tile-purple',
  slate: 'bg-tile-slate',
  amber: 'bg-tile-amber',
};

/** The item's name for a screen reader, with its count and «جدید». */
export const itemName = (item: DeskItem) =>
  [item.label, item.count ? `${faDigits(item.count)} مورد در انتظار` : '', item.isNew ? 'جدید' : '']
    .filter(Boolean)
    .join('، ');

/** A panel's section as its app lists it: the group is a key of the app's groups. */
export interface SectionOf<G extends string> {
  readonly href: string;
  readonly label: string;
  /** The bottom bar's label: at most {@link SHORT_LABEL_MAX} letters. */
  readonly shortLabel: string;
  readonly description: string;
  readonly group: G;
  readonly glyph: GlyphName;
  readonly isNew?: boolean;
}

/**
 * The sections as the desk and the menu show them: by group, in the groups' order, with the
 * group's color and label, each with its count if one is known.
 */
export function toDeskItems<G extends string>(
  sections: readonly SectionOf<G>[],
  groups: Readonly<Record<G, { readonly label: string; readonly color: TileColor }>>,
  counts: Readonly<Record<string, number>> = {},
): DeskItem[] {
  const order = Object.keys(groups);
  return [...sections]
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
    .map((s) => {
      const count = counts[s.href];
      return {
        href: s.href,
        label: s.label,
        shortLabel: s.shortLabel,
        description: s.description,
        glyph: s.glyph,
        color: groups[s.group].color,
        group: groups[s.group].label,
        ...(s.isNew ? { isNew: true } : {}),
        ...(count ? { count } : {}),
      };
    });
}

/** The shortcuts of a phone's bar: the first `count` items in the app's order of use. */
export function shortcutsIn(
  items: readonly DeskItem[],
  order: readonly string[],
  count = 4,
): DeskItem[] {
  const rank = (href: string) => {
    const i = order.indexOf(href);
    return i === -1 ? order.length : i;
  };
  return [...items].sort((a, b) => rank(a.href) - rank(b.href)).slice(0, count);
}

/** The banners in force (`GET /config/banners`) as the desk's slides. */
export function bannerSlides(
  banners: readonly {
    title: string;
    body: string;
    tone: 'accent' | 'highlight' | 'indigo' | 'teal' | 'rose' | 'amber';
    imageUrl: string | null;
    linkHref: string | null;
    linkLabel: string | null;
    displaySeconds: number;
  }[],
) {
  return banners.map((b) => ({
    title: b.title,
    text: b.body,
    tone: b.tone,
    seconds: b.displaySeconds,
    ...(b.imageUrl ? { imageUrl: b.imageUrl } : {}),
    ...(b.linkHref ? { href: b.linkHref, linkLabel: b.linkLabel ?? 'بیشتر' } : {}),
  }));
}

/** The longest bottom-bar label (owner 1405/08/11): it fits a phone of 360 pixels on one line. */
export const SHORT_LABEL_MAX = 12;
