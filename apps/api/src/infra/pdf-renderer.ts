import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { chromium, type Browser } from 'playwright-core';
import type { PdfRenderer } from '../common/pdf/pdf-renderer.port';

/**
 * PDF with headless Chromium (ADR-033): HTML and CSS shape Persian text and lay it out
 * right to left, which simple PDF libraries do not. One browser for every job, started on
 * the first and closed on shutdown. Each page refuses every request but inline data, so a
 * contract never reaches the network (rules 17–20).
 *
 * The browser: PDF_BROWSER_PATH (Chromium of the worker's image), else the installed
 * Chrome (development and tests, as the end-to-end tests use).
 */
export class ChromiumPdfRenderer implements PdfRenderer, OnApplicationShutdown {
  private readonly logger = new Logger(ChromiumPdfRenderer.name);
  private browser: Promise<Browser> | null = null;

  constructor(private readonly executablePath: string | undefined) {}

  private launch(): Promise<Browser> {
    this.browser ??= chromium
      .launch(
        this.executablePath
          ? { executablePath: this.executablePath, headless: true }
          : { channel: 'chrome', headless: true },
      )
      .catch((error: unknown) => {
        this.browser = null;
        throw error;
      });
    return this.browser;
  }

  async render(html: string): Promise<Buffer> {
    const browser = await this.launch();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) =>
        route.request().url().startsWith('data:') ? route.continue() : route.abort(),
      );
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate('document.fonts.ready').catch(() => undefined);
      return await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
      });
    } finally {
      await context.close();
    }
  }

  async onApplicationShutdown() {
    const browser = await this.browser?.catch(() => null);
    await browser?.close().catch((error: unknown) => {
      this.logger.warn(`closing the PDF browser: ${(error as Error).message}`);
    });
  }
}

export const pdfRendererFromEnv = () =>
  new ChromiumPdfRenderer(process.env['PDF_BROWSER_PATH'] || undefined);
