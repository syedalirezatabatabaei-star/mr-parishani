import { ApiError, authApi, createApiClient, type Me, type MyAccess } from '@sepehr/api-client';
import type { PermissionCode } from '@sepehr/contracts';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { PATH_HEADER, signInAgain } from './login-gate';

/** The session cookie the API sets (apps/api identity/web.ts). */
export const SESSION_COOKIE = '__Host-sid';

/**
 * The API as server pages call it: straight to the API, with the visitor's cookies and the
 * client address passed on (the API trusts this server through TRUST_PROXY). Server only.
 *
 * On a page that needs a session (login-gate.ts), a cookie the API no longer takes sends the
 * visitor to sign in again and back (owner 1405/08/09), rather than every call on the page
 * failing with its own message. Pages call this first, outside their try blocks, where
 * `redirect` must be (Next.js: it throws).
 */
export async function serverApi() {
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const path = incoming.get(PATH_HEADER);
  if (path && jar.has(SESSION_COOKIE)) {
    // An API that cannot answer is not a reason to sign in again: the page says so itself.
    const live = await getSession().then(
      (session) => session !== null,
      () => true,
    );
    const to = signInAgain(path, true, live);
    if (to) redirect(to);
  }
  return client();
}

async function client() {
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const cookie = jar.toString();
  const forwardedFor = incoming.get('x-forwarded-for');
  const userAgent = incoming.get('user-agent');
  return createApiClient({
    baseUrl: process.env['API_INTERNAL_URL'] ?? 'http://localhost:3000',
    headers: () => ({
      ...(cookie ? { cookie } : {}),
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      ...(userAgent ? { 'user-agent': userAgent } : {}),
    }),
  });
}

export interface Session {
  readonly me: Me;
  readonly access: MyAccess;
}

/**
 * The visitor's session and permissions, once per request; null when not signed in, or
 * when sign-in is half done (TOTP still due).
 */
export const getSession = cache(async (): Promise<Session | null> => {
  // No cookie, no session: spare the API two calls on every public page.
  if (!(await cookies()).has(SESSION_COOKIE)) return null;
  const auth = authApi(await client());
  try {
    const me = await auth.me();
    if (me.stage !== 'active') return null;
    return { me, access: await auth.access() };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
});

/** Whether the session holds any of the permissions. */
export const can = (session: Session | null, ...permissions: readonly PermissionCode[]) =>
  session !== null && permissions.some((p) => session.access.permissions.includes(p));
