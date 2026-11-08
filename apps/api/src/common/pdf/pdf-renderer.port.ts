/**
 * Turns a self-contained HTML document into a PDF (ADR-033; task 4-1): Persian text, right
 * to left, with the self-hosted font embedded. No network: whatever the page asks for
 * that is not inline is refused (rules 17–20). The worker provides it; contracts use it.
 */
export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
}

export const PDF_RENDERER = Symbol('PDF_RENDERER');
