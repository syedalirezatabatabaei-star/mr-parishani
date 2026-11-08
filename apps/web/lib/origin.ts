/**
 * The site's public address (`PUBLIC_WEB_ORIGIN`, e.g. https://app.sepehr.example): the
 * canonical links and Open Graph URLs of public pages are absolute (doc 08 §10).
 */
export function publicOrigin(): string {
  const origin = process.env['PUBLIC_WEB_ORIGIN'] ?? 'http://localhost:3001';
  return origin.replace(/\/+$/, '');
}
