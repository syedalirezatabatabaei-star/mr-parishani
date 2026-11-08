import { ApiError, authApi, createApiClient, type Me, type MyAccess } from '@sepehr/api-client';
import type { PermissionCode } from '@sepehr/contracts';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';

/** The session cookie the API sets (apps/api identity/web.ts). */
export const SESSION_COOKIE = '__Host-sid';

/**
 * The API as server pages call it: straight to the API, with the visitor's cookies and the
 * client address passed on (the API trusts this server through TRUST_PROXY). Server only.
 */
export async function serverApi() {
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
  const auth = authApi(await serverApi());
  try {
    const me = await auth.me();
    if (me.stage !== 'active') return null;
    // Task 9-3 (owner, question 3): until the mobile is proved, only the form it requires is
    // shown, and the API answers nothing else (not even the permissions).
    if (me.mobileRequired) {
      return { me, access: { roles: [], permissions: [], scopes: [] } };
    }
    return { me, access: await auth.access() };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
});

/** Whether the session holds any of the permissions. */
export const can = (session: Session | null, ...permissions: readonly PermissionCode[]) =>
  session !== null && permissions.some((p) => session.access.permissions.includes(p));
