/**
 * The service desk's glyphs (owner 1405/08/10): one line set drawn for Sepehr on a 24 grid,
 * stroked in the current color (white on a desk tile, ink in a list). Nothing borrowed from
 * another app; nothing fetched (rule 19).
 */
const PATHS = {
  home: 'M4 11 12 4l8 7M6 9.5V20h4.5v-5h3v5H18V9.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2 2 0 0 0 4 0',
  close: 'M6 6l12 12M18 6 6 18',
  calendar: 'M5 6h14v14H5zM5 10h14M9 4v4M15 4v4M8.5 14h2M13.5 14h2M8.5 17h2',
  doctor:
    'M7 4v5a4 4 0 0 0 8 0V4M7 4h1.5M15 4h-1.5M11 13v2a4 4 0 0 0 8 0v-1.5M19 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  proforma: 'M7 3h7l4 4v14H7zM14 3v4h4M10 11h5M10 14h5M10 17h3',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3ZM9 12l2 2 4-4',
  coins:
    'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3ZM4 5v4c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 9v4c0 1.7 3.6 3 8 3s8-1.3 8-3V9M4 13v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4',
  contract: 'M6 3h9l3 3v8M6 3v18h7M9 8h6M9 11h6M9 14h3M14 20l1.5-3.5L20 12l1.5 1.5-4.5 4.5L14 20Z',
  guarantee:
    'M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20a5.5 5.5 0 0 1 11 0M15.5 11a3 3 0 1 0 0-6M17 14.5A5.5 5.5 0 0 1 21 20',
  chat: 'M4 5h16v11H9l-5 4V5ZM8 9.5h8M8 12.5h5',
  mobile: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  chart: 'M4 20h16M7 20v-6M11 20V9M15 20v-9M19 20V5',
  units: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  report: 'M6 3h9l3 3v15H6zM9 17v-3M12 17v-6M15 17v-4',
  building: 'M4 20h16M6 20V5h8v15M14 9h4v11M9 8h2M9 11h2M9 14h2M16.5 12v.01M16.5 15v.01',
  idCard: 'M3 6h18v12H3zM8.5 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5.5 16a3 3 0 0 1 6 0M14 9.5h4M14 13h4',
  upload: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v5h14v-5',
  funnel: 'M4 5h16l-6 7.5V19l-4 1.5v-8L4 5Z',
  share:
    'M6 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM18 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1',
  userCheck:
    'M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 20a6.5 6.5 0 0 1 11-4.7M15 19l2 2 4-4',
  key: 'M8.5 15.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 11.5h8.5M17.5 11.5V15M20.5 11.5V14',
  swap: 'M5 8h13l-3.5-3.5M19 16H6l3.5 3.5',
  folder: 'M3 6h6l2 2h10v11H3zM9.5 14l2 2 4-4',
  clipboard: 'M8 5H6v16h12V5h-2M9 3h6v4H9zM9 12h6M9 15h6M9 18h3',
  receipt: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21zM9 8h6M9 11h6M9 14h4',
  wallet: 'M4 7h15a1 1 0 0 1 1 1v11H4zM4 7l11-3v3M16 13.5h.01M20 11h-4a2.5 2.5 0 0 0 0 5h4',
  cheque: 'M3 7h18v10H3zM6 14h5M6 11h3M14 13l1.5-2 1.5 2 1.5-2',
  alarm: 'M12 21a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM12 10v4l2.5 1.5M4 5l3-2M20 5l-3-2',
  envelope: 'M3 6h18v12H3zM3 7l9 6.5L21 7',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6l1-7Z',
  bank: 'M3 9.5 12 4l9 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3 20h18',
  percent:
    'M18 6 6 18M7.5 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM16.5 19a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  badgeCheck:
    'M12 3l2.4 1.8 3-.2.9 2.8 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.8-3-.2L12 21l-2.4-1.8-3 .2-.9-2.8-2.4-1.8 1-2.8-1-2.8L5.7 7.4l.9-2.8 3 .2L12 3ZM9 12l2 2 4-4',
  crown: 'M4 18h16M4.5 15 3.5 7l5 3.5L12 5l3.5 5.5 5-3.5-1 8z',
  tag: 'M3.5 12.5 12 4h8v8l-8.5 8.5zM16 9a1 1 0 1 0 0-.01M9 14l3 3',
  priceTag:
    'M4 5h7l9 9-6 6-9-9V5ZM8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.5 15.5l4-4M13 17l1-1',
  holiday: 'M5 6h14v14H5zM5 10h14M9 4v4M15 4v4M10 13l4 4M14 13l-4 4',
  rocket:
    'M14 4c3 0 6 3 6 6l-6 6-6-6 6-6ZM8 10l-3 1-2 3 4 .5M14 16l-1 3-3 2-.5-4M15.5 9.5a1.5 1.5 0 1 0 0-.01M6 18l-2 2',
  sliders:
    'M4 7h9M17 7h3M4 17h3M11 17h9M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM4 12h4M12 12h8M10 14a2 2 0 1 0 0-4',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 14.5v2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 21a7.5 7.5 0 0 1 15 0',
  users:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18.5 14a6.5 6.5 0 0 1 3 6',
  heart:
    'M12 20s-7.5-4.5-7.5-10A4.2 4.2 0 0 1 12 7.5 4.2 4.2 0 0 1 19.5 10c0 5.5-7.5 10-7.5 10ZM8.5 12h2l1-2 2 4 1-2h1',
  alert: 'M4 5h16v11H9l-5 4V5ZM12 8v4M12 14.5v.01',
  grid: 'M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  moon: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.5v.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  stethoscope:
    'M6 3v6a4 4 0 0 0 8 0V3M6 3h1.5M14 3h-1.5M10 13v2.5a4.5 4.5 0 0 0 9 0V13M19 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  history: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2',
} as const;

export type GlyphName = keyof typeof PATHS;
export const GLYPH_NAMES = Object.keys(PATHS) as GlyphName[];

/** A glyph, decorative: its link or button carries the name. */
export function Glyph({ name, className = 'size-6' }: { name: GlyphName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
