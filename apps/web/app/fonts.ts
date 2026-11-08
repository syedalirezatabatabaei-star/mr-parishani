import localFont from 'next/font/local';

/**
 * The fonts, self-hosted (rules 18 and 19): the files live in packages/ui/fonts with their
 * OFL licenses and are served by this app, never fetched from a CDN (task 2-10).
 *
 * This is the one place to swap a font once a commercial Persian font is licensed (doc 09
 * note on 2-10): change the file here (and the text font in apps/admin/app/fonts.ts), and
 * `--font-text` or `--font-display` follows everywhere.
 */

/** Text: Vazirmatn, a variable font; its `tnum` feature gives tabular digits for money. */
export const textFont = localFont({
  src: '../../../packages/ui/fonts/Vazirmatn-Variable.woff2',
  variable: '--font-text',
  weight: '100 900',
  display: 'swap',
  // The metric-matched Tahoma of @sepehr/ui/theme.css, not next/font's Arial-based one: Arial's
  // metrics fit Latin text, and Persian text reflowed when Vazirmatn arrived (owner 1405/08/02).
  adjustFontFallback: false,
  fallback: ['Sepehr Text Fallback', 'system-ui', 'Tahoma', 'sans-serif'],
});

/** Display: Estedad, for the headings of the patient pages (the expressive language). */
export const displayFont = localFont({
  src: [
    { path: '../../../packages/ui/fonts/Estedad-500.woff2', weight: '500' },
    { path: '../../../packages/ui/fonts/Estedad-700.woff2', weight: '700' },
    { path: '../../../packages/ui/fonts/Estedad-800.woff2', weight: '800' },
  ],
  variable: '--font-display',
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['Sepehr Display Fallback', 'var(--font-text)', 'system-ui', 'sans-serif'],
});
