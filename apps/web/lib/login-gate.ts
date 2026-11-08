/**
 * Areas that need a signed-in visitor, and where each signs in (shared by proxy.ts and
 * serverApi). Only a convenience for the visitor: every API call checks the session and the
 * permission itself (rule 12).
 */
export const GATED: readonly { prefix: string; login: string }[] = [
  { prefix: '/panel', login: '/panel/login' },
  { prefix: '/me', login: '/login' },
  // Free times and holding a slot are for signed-in patients (ADR-027).
  { prefix: '/book', login: '/login' },
];

/** The header proxy.ts sets on every page request: its path and query, for the way back. */
export const PATH_HEADER = 'x-sepehr-path';

/** The sign-in page of a gated area, or null (a public page, or a sign-in page itself). */
export function loginFor(pathname: string): string | null {
  const gate = GATED.find(
    (g) =>
      (pathname === g.prefix || pathname.startsWith(`${g.prefix}/`)) &&
      !pathname.startsWith(g.login),
  );
  return gate?.login ?? null;
}

/**
 * Owner 1405/08/09: where to send a visitor whose session cookie the API no longer takes
 * (ended, expired, or from before the database was made again), back to this page after the
 * sign-in; null to stay. Without a cookie the proxy has already sent them; on a public page
 * nothing needs a session.
 */
export function signInAgain(path: string | null, hasCookie: boolean, live: boolean): string | null {
  if (!path || !hasCookie || live) return null;
  const login = loginFor(path.split('?')[0] ?? path);
  return login ? `${login}?next=${encodeURIComponent(path)}` : null;
}
