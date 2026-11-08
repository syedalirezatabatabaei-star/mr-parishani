import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// No telemetry to servers outside Iran (CLAUDE.md rules 17–18).
process.env['NEXT_TELEMETRY_DISABLED'] = '1';

/**
 * Headers on every response, the static files too (task 9-3, R9: ZAP found them missing on
 * /_next/static). The CSP, with its nonce, is set per request in proxy.ts.
 */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

/**
 * The production image (Dockerfile.next) builds Next's standalone server, traced from the
 * repository root so the workspace packages come along. Elsewhere `next start` as before.
 */
const standalone =
  process.env['NEXT_OUTPUT'] === 'standalone'
    ? { output: 'standalone' as const, outputFileTracingRoot: resolve(process.cwd(), '../..') }
    : {};

const nextConfig: NextConfig = {
  ...standalone,
  poweredByHeader: false,
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: SECURITY_HEADERS }]);
  },
};

export default nextConfig;
