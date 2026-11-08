/**
 * The design tokens (task 2-10, doc 08 §13): one source for both visual languages, turned
 * into CSS variables (`tokenCss()`, written to `dist/tokens.css` at build) and checked for
 * WCAG 2.2 AA contrast by a test.
 *
 * - `panel`: internal and center panels. Calm and dense: cool neutrals and one accent,
 *   lapis (لاجوردی).
 * - `patient`: patient pages and public profiles. Warm and expressive: a cream ground,
 *   turquoise (فیروزه‌ای) and saffron-terracotta, from Persian tilework rather than the
 *   usual «medical blue».
 *
 * Colors are hex so their contrast can be computed exactly; names say what they are for.
 */

export type Tone = 'panel' | 'patient';

export interface ColorSet {
  /** The page. */
  readonly canvas: string;
  /** Cards, dialogs, inputs. */
  readonly surface: string;
  /** Wells, table stripes, disabled fields. */
  readonly sunken: string;
  /** Hairlines between areas (decorative, no contrast duty). */
  readonly border: string;
  /** Borders that identify a control (inputs, checkboxes): 3:1 against the surface. */
  readonly borderStrong: string;
  readonly ink: string;
  readonly inkMuted: string;
  /** The faintest text still readable (helper text, captions): 4.5:1. */
  readonly inkSubtle: string;
  readonly accent: string;
  readonly accentHover: string;
  readonly onAccent: string;
  readonly accentSoft: string;
  readonly onAccentSoft: string;
  /** A second, expressive color (patient: saffron-terracotta; panel: same as accent). */
  readonly highlight: string;
  readonly onHighlight: string;
  readonly highlightSoft: string;
  readonly onHighlightSoft: string;
  readonly success: string;
  readonly successSoft: string;
  readonly warning: string;
  readonly warningSoft: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly info: string;
  readonly infoSoft: string;
  /** The focus ring: 3:1 against canvas and surface (WCAG 2.4.13 / 1.4.11). */
  readonly focus: string;
  /** Holidays in calendars (doc 08 §13): distinct from weekends and selection. */
  readonly holiday: string;
  readonly holidaySoft: string;
}

export const COLORS: Readonly<Record<Tone, ColorSet>> = {
  panel: {
    canvas: '#F3F4F2',
    surface: '#FFFFFF',
    sunken: '#ECEEEB',
    border: '#DDE1DC',
    borderStrong: '#7A837C',
    ink: '#1A2124',
    inkMuted: '#4E595E',
    inkSubtle: '#626D72',
    accent: '#274C8C',
    accentHover: '#1D3A6C',
    onAccent: '#FFFFFF',
    accentSoft: '#E5EBF5',
    onAccentSoft: '#1D3A6C',
    highlight: '#274C8C',
    onHighlight: '#FFFFFF',
    highlightSoft: '#E5EBF5',
    onHighlightSoft: '#1D3A6C',
    success: '#1B6B45',
    successSoft: '#E2F1E8',
    warning: '#855600',
    warningSoft: '#FAEFD6',
    danger: '#B3261E',
    dangerSoft: '#FBE6E4',
    info: '#1C5BA6',
    infoSoft: '#E3EDF9',
    focus: '#0B6E75',
    holiday: '#B3261E',
    holidaySoft: '#FBE6E4',
  },
  patient: {
    canvas: '#FBF5EC',
    surface: '#FFFDF9',
    sunken: '#F3EADB',
    border: '#E8DAC5',
    borderStrong: '#8A7356',
    ink: '#2A1E16',
    inkMuted: '#5B4839',
    inkSubtle: '#6E5A49',
    accent: '#0B6B6B',
    accentHover: '#075353',
    onAccent: '#FFFFFF',
    accentSoft: '#DCEFEC',
    onAccentSoft: '#074646',
    highlight: '#B0441A',
    onHighlight: '#FFFFFF',
    highlightSoft: '#FBE5D6',
    onHighlightSoft: '#7A2E0F',
    success: '#1B6B45',
    successSoft: '#E2F1E8',
    warning: '#855600',
    warningSoft: '#FAEFD6',
    danger: '#B3261E',
    dangerSoft: '#FBE6E4',
    info: '#1C5BA6',
    infoSoft: '#E3EDF9',
    focus: '#1C5BA6',
    holiday: '#B3261E',
    holidaySoft: '#FBE6E4',
  },
};

/**
 * The dark theme (owner 1405/08/10): the same names for each tone, chosen by the visitor in
 * the menu and kept in a cookie (`THEME_COOKIE`). Checked for the same contrast as the light.
 */
export const DARK_COLORS: Readonly<Record<Tone, ColorSet>> = {
  panel: {
    canvas: '#121719',
    surface: '#1A2125',
    sunken: '#151B1E',
    border: '#2C363B',
    borderStrong: '#7F8C92',
    ink: '#E7EBED',
    inkMuted: '#B6C0C5',
    inkSubtle: '#9DA9AF',
    accent: '#93B3EC',
    accentHover: '#ADC6F1',
    onAccent: '#0B1626',
    accentSoft: '#22314A',
    onAccentSoft: '#CBD9F4',
    highlight: '#93B3EC',
    onHighlight: '#0B1626',
    highlightSoft: '#22314A',
    onHighlightSoft: '#CBD9F4',
    success: '#7CD3A5',
    successSoft: '#14301F',
    warning: '#E9BA60',
    warningSoft: '#33270F',
    danger: '#F4998F',
    dangerSoft: '#3B1A17',
    info: '#90BAEE',
    infoSoft: '#172A42',
    focus: '#5CC9D0',
    holiday: '#F4998F',
    holidaySoft: '#3B1A17',
  },
  patient: {
    canvas: '#17120E',
    surface: '#211A15',
    sunken: '#1B1511',
    border: '#3A2F26',
    borderStrong: '#9E886B',
    ink: '#F4EBE0',
    inkMuted: '#CFBDAA',
    inkSubtle: '#B6A38F',
    accent: '#5FCAC3',
    accentHover: '#7DD7D1',
    onAccent: '#062424',
    accentSoft: '#143633',
    onAccentSoft: '#BAEAE5',
    highlight: '#F09362',
    onHighlight: '#2A1206',
    highlightSoft: '#3D2214',
    onHighlightSoft: '#F8C8AB',
    success: '#7CD3A5',
    successSoft: '#14301F',
    warning: '#E9BA60',
    warningSoft: '#33270F',
    danger: '#F4998F',
    dangerSoft: '#3B1A17',
    info: '#90BAEE',
    infoSoft: '#172A42',
    focus: '#90BAEE',
    holiday: '#F4998F',
    holidaySoft: '#3B1A17',
  },
};

/** The cookie that keeps the visitor's theme: `dark`, or anything else for light. */
export const THEME_COOKIE = 'sepehr-theme';

/**
 * The service desk's group colors (owner 1405/08/10): a white glyph on each, 4.5:1 or more,
 * in both themes. One color per group of services, so a group reads at a glance.
 */
export const TILE_COLORS = {
  indigo: '#3F51B5',
  teal: '#00796B',
  orange: '#C2410C',
  rose: '#BE185D',
  green: '#2E7D32',
  blue: '#1D63C9',
  purple: '#7B3FA0',
  slate: '#4A5A63',
  amber: '#9A5800',
} as const;
export type TileColor = keyof typeof TILE_COLORS;

/** Spacing on a 4-pixel grid; the panel uses the smaller steps for density. */
export const SPACE = {
  '0': '0',
  '1': '0.25rem',
  '2': '0.5rem',
  '3': '0.75rem',
  '4': '1rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '8': '2rem',
  '10': '2.5rem',
  '12': '3rem',
  '16': '4rem',
} as const;

export const RADIUS: Readonly<Record<Tone, { sm: string; md: string; lg: string; pill: string }>> =
  {
    panel: { sm: '0.25rem', md: '0.375rem', lg: '0.5rem', pill: '999px' },
    patient: { sm: '0.5rem', md: '0.875rem', lg: '1.5rem', pill: '999px' },
  };

export const SHADOW: Readonly<Record<Tone, { sm: string; md: string; lg: string }>> = {
  panel: {
    sm: '0 1px 1px rgb(26 33 36 / 0.06)',
    md: '0 1px 2px rgb(26 33 36 / 0.08), 0 2px 6px rgb(26 33 36 / 0.06)',
    lg: '0 4px 12px rgb(26 33 36 / 0.10), 0 12px 32px rgb(26 33 36 / 0.08)',
  },
  patient: {
    sm: '0 1px 2px rgb(74 48 22 / 0.08)',
    md: '0 2px 6px rgb(74 48 22 / 0.08), 0 8px 20px rgb(74 48 22 / 0.06)',
    lg: '0 8px 24px rgb(74 48 22 / 0.12), 0 24px 48px rgb(74 48 22 / 0.08)',
  },
};

/**
 * Motion: short and purposeful; every duration becomes 0 under
 * `prefers-reduced-motion: reduce` (WCAG 2.3.3), so nothing moves for who asked.
 */
export const MOTION = {
  fast: '120ms',
  base: '200ms',
  slow: '320ms',
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
} as const;

/**
 * Type scale (rem) and line heights. Persian needs a taller line than Latin; financial
 * figures use tabular digits (Vazirmatn `tnum`: every digit 1349 units wide).
 */
export const TYPE = {
  size: {
    xs: '0.75rem',
    sm: '0.8125rem',
    base: '0.9375rem',
    md: '1.0625rem',
    lg: '1.25rem',
    xl: '1.5rem',
    '2xl': '2rem',
    '3xl': '2.75rem',
  },
  leading: { tight: '1.35', base: '1.75', relaxed: '1.95' },
} as const;

// --- contrast (WCAG 2.2) ---------------------------------------------------------------

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** The WCAG contrast ratio of two opaque colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The pairs the UI actually uses and the ratio each must reach: 4.5 for text, 3 for large
 * text and the parts of controls (WCAG 1.4.3, 1.4.11).
 */
export function contrastPairs(
  c: ColorSet,
): { name: string; fg: string; bg: string; min: number }[] {
  const text = (name: string, fg: string, bg: string) => ({ name, fg, bg, min: 4.5 });
  const ui = (name: string, fg: string, bg: string) => ({ name, fg, bg, min: 3 });
  const pairs = [
    text('ink/canvas', c.ink, c.canvas),
    text('ink/surface', c.ink, c.surface),
    text('ink/sunken', c.ink, c.sunken),
    text('inkMuted/canvas', c.inkMuted, c.canvas),
    text('inkMuted/surface', c.inkMuted, c.surface),
    text('inkSubtle/surface', c.inkSubtle, c.surface),
    text('inkSubtle/canvas', c.inkSubtle, c.canvas),
    text('onAccent/accent', c.onAccent, c.accent),
    text('onAccent/accentHover', c.onAccent, c.accentHover),
    text('onAccentSoft/accentSoft', c.onAccentSoft, c.accentSoft),
    text('accent/surface', c.accent, c.surface),
    text('accent/canvas', c.accent, c.canvas),
    text('onHighlight/highlight', c.onHighlight, c.highlight),
    text('onHighlightSoft/highlightSoft', c.onHighlightSoft, c.highlightSoft),
    text('success/successSoft', c.success, c.successSoft),
    text('warning/warningSoft', c.warning, c.warningSoft),
    text('danger/dangerSoft', c.danger, c.dangerSoft),
    text('info/infoSoft', c.info, c.infoSoft),
    text('danger/surface', c.danger, c.surface),
    text('holiday/surface', c.holiday, c.surface),
    text('holiday/holidaySoft', c.holiday, c.holidaySoft),
    ui('borderStrong/surface', c.borderStrong, c.surface),
    ui('borderStrong/canvas', c.borderStrong, c.canvas),
    ui('focus/surface', c.focus, c.surface),
    ui('focus/canvas', c.focus, c.canvas),
    ui('accent/canvas (control)', c.accent, c.canvas),
  ];
  return pairs;
}

// --- CSS -------------------------------------------------------------------------------

const kebab = (name: string) => name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

const colorLines = (set: ColorSet) =>
  Object.entries(set as unknown as Record<string, string>).map(
    ([k, v]) => `  --color-${kebab(k)}: ${v};`,
  );

function toneBlock(tone: Tone): string {
  const lines = [
    ...colorLines(COLORS[tone]),
    ...Object.entries(RADIUS[tone]).map(([k, v]) => `  --radius-${k}: ${v};`),
    ...Object.entries(SHADOW[tone]).map(([k, v]) => `  --shadow-${k}: ${v};`),
    `  --font-heading: ${tone === 'patient' ? 'var(--font-display)' : 'var(--font-text)'};`,
  ];
  return lines.join('\n');
}

/**
 * The tokens as CSS. `:root` is the panel; `[data-tone]` switches a subtree. The fonts'
 * families come from the app (`--font-text`, `--font-display`, set by next/font).
 */
export function tokenCss(): string {
  const shared = [
    ...Object.entries(SPACE).map(([k, v]) => `  --space-${k}: ${v};`),
    ...Object.entries(TYPE.size).map(([k, v]) => `  --text-${k}: ${v};`),
    ...Object.entries(TYPE.leading).map(([k, v]) => `  --leading-${k}: ${v};`),
    `  --duration-fast: ${MOTION.fast};`,
    `  --duration-base: ${MOTION.base};`,
    `  --duration-slow: ${MOTION.slow};`,
    `  --ease: ${MOTION.ease};`,
    `  --ease-out: ${MOTION.easeOut};`,
    ...Object.entries(TILE_COLORS).map(([k, v]) => `  --color-tile-${k}: ${v};`),
  ].join('\n');
  // The dark theme is set on the shell beside its tone, or on an ancestor of it.
  const dark = (tone: Tone) =>
    [
      `[data-theme='dark'][data-tone='${tone}'],`,
      `[data-theme='dark'] [data-tone='${tone}'] {`,
      '  color-scheme: dark;',
      ...colorLines(DARK_COLORS[tone]),
      '}',
    ].join('\n');
  return `/* Generated from packages/ui/src/tokens.ts (task 2-10). Do not edit. */
:root {
${shared}
${toneBlock('panel')}
}
[data-tone='panel'] {
${toneBlock('panel')}
}
[data-tone='patient'] {
${toneBlock('patient')}
}
${dark('panel')}
${dark('patient')}
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-base: 0ms;
    --duration-slow: 0ms;
  }
}
`;
}
