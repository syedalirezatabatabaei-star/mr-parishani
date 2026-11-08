/**
 * The Content-Security-Policy of the web and admin apps (CLAUDE.md rules 17–20): nothing
 * outside the app's own origin, except the file store when its signed links live on another
 * host of ours (`mediaOrigin`). Scripts run only with the request's nonce; Next.js puts the
 * nonce on its own scripts when it finds it in the request's CSP header.
 *
 * `style-src-attr 'unsafe-inline'`: React writes `style` attributes (a swatch's color, a
 * bar's width). Attributes cannot run code; `<style>` elements still need the nonce.
 */
export interface CspOptions {
  readonly nonce: string;
  /**
   * Development: React needs `eval` for its error overlays and the dev server injects inline
   * styles. Never in production.
   */
  readonly development: boolean;
  /** The origin of signed file links (S3-compatible store), when not the app itself. */
  readonly mediaOrigin?: string | null;
  /** Frames allowed, e.g. the Aparat player of a profile video (ADR-029); none by default. */
  readonly frameOrigins?: readonly string[];
}

export function contentSecurityPolicy(options: CspOptions): string {
  const media = options.mediaOrigin ? ` ${options.mediaOrigin}` : '';
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${options.nonce}' 'strict-dynamic'${options.development ? ` 'unsafe-eval'` : ''}`,
    // The dev server injects its CSS as <style> elements without a nonce; a build serves files.
    options.development
      ? `style-src 'self' 'unsafe-inline'`
      : `style-src 'self' 'nonce-${options.nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' blob: data:${media}`,
    `media-src 'self' blob:${media}`,
    `font-src 'self'`,
    // The API is reached through the app's own origin (rewrites), never directly.
    `connect-src 'self'${options.development ? ' ws:' : ''}`,
    options.frameOrigins && options.frameOrigins.length > 0
      ? `frame-src ${options.frameOrigins.join(' ')}`
      : `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (!options.development) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/** A fresh, unguessable nonce for one response (base64 of 16 random bytes). */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
