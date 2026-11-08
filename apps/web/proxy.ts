import { contentSecurityPolicy, newNonce } from '@sepehr/ui/csp';
import { NextResponse, type NextRequest } from 'next/server';
import { loginFor, PATH_HEADER } from './lib/login-gate';

/** The session cookie the API sets (apps/api identity/web.ts). */
const SESSION_COOKIE = '__Host-sid';

/**
 * Runs before every page: a fresh CSP nonce (rules 17–20), the security headers, and the
 * way to the sign-in page for a gated area without a session cookie.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // The API on this app's own origin (task 2-11): passed on to API_INTERNAL_URL, read at
  // run time (a next.config rewrite would freeze the address into the build).
  if (pathname.startsWith('/api/v1/')) {
    const api = process.env['API_INTERNAL_URL'] ?? 'http://localhost:3000';
    return NextResponse.rewrite(new URL(`${pathname}${search}`, api));
  }
  const gate = loginFor(pathname);
  if (gate && !request.cookies.has(SESSION_COOKIE)) {
    const login = new URL(gate, request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  const nonce = newNonce();
  const csp = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === 'development',
    mediaOrigin: process.env['MEDIA_ORIGIN'] ?? null,
    frameOrigins: ['https://www.aparat.com'],
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  // Always this request's own: serverApi's way back after a sign-in (a sent one is replaced).
  requestHeaders.set(PATH_HEADER, `${pathname}${search}`);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  return response;
}

export const config = {
  matcher: [
    {
      // Not static files or prefetches.
      source: '/((?!_next/static|_next/image|favicon.ico|fonts/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
