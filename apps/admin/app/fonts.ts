import localFont from 'next/font/local';

/**
 * The fonts, self-hosted (rules 18 and 19): the files live in packages/ui/fonts with their
 * OFL licenses and are served by this app, never fetched from a CDN (task 2-10).
 *
 * This is the one place to swap a font once a commercial Persian font is licensed (doc 09
 * note on 2-10): change the file here and in apps/web/app/fonts.ts.
 */

/** Text: Vazirmatn, a variable font; its `tnum` feature gives tabular digits for money. */
export const textFont = localFont({
  src: '../../../packages/ui/fonts/Vazirmatn-Variable.woff2',
  variable: '--font-text',
  weight: '100 900',
  display: 'swap',
  // The metric-matched Tahoma of @sepehr/ui/theme.css (owner 1405/08/02), as the web app.
  adjustFontFallback: false,
  fallback: ['Sepehr Text Fallback', 'system-ui', 'Tahoma', 'sans-serif'],
});
