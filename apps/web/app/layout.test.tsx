import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RootLayout from './layout';

// next/font/local runs only under Next's compiler; here each font is its CSS variable class.
vi.mock('./fonts', () => ({
  textFont: { variable: 'font-text-variable' },
  displayFont: { variable: 'font-display-variable' },
}));

// Rendering waits for a request (the CSP nonce); here there is one already.
vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));

describe('RootLayout', () => {
  it('renders a right-to-left Persian document with the self-hosted fonts', async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: 'x' }));
    expect(html).toMatch(
      /^<html lang="fa" dir="rtl" class="font-text-variable font-display-variable">/,
    );
  });
});
