import { contentSecurityPolicy, newNonce } from '@sepehr/ui/csp';
import { NextResponse, type NextRequest } from 'next/server';

/** The session cookie the API sets (apps/api identity/web.ts). */
const SESSION_COOKIE = '__Host-sid';
const LOGIN = '/login';

/**
 * Runs before every page of the internal panel: a fresh CSP nonce (rules 17–20), the
 * security headers, and the way to sign-in for a visitor without a session cookie. The
 * whole panel is gated; the API checks the session, the permission and the office network
 * itself (rule 12, doc 04).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // The API on this app's own origin (task 2-11): passed on to API_INTERNAL_URL, read at
  // run time (a next.config rewrite would freeze the address into the build).
  if (pathname.startsWith('/api/v1/')) {
    const api = process.env['API_INTERNAL_URL'] ?? 'http://localhost:3000';
    return NextResponse.rewrite(new URL(`${pathname}${search}`, api));
  }
  if (!pathname.startsWith(LOGIN) && !request.cookies.has(SESSION_COOKIE)) {
    const login = new URL(LOGIN, request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  const nonce = newNonce();
  const csp = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === 'development',
    mediaOrigin: process.env['MEDIA_ORIGIN'] ?? null,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
