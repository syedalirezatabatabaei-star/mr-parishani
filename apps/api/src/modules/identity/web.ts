import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { RequestMeta } from './identity.tokens';

/**
 * Cookies and headers of the web and mobile clients.
 *
 * `__Host-` cookies must be Secure, have Path=/ and no Domain, so a sibling subdomain
 * cannot set or read them. Browsers accept Secure cookies on http://localhost too.
 */
export const SESSION_COOKIE = '__Host-sid';
export const DEVICE_COOKIE = '__Host-did';
export const CSRF_HEADER = 'x-csrf-token';
export const DEVICE_HEADER = 'x-device-id';

const DEVICE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

function cookies(req: Request): Record<string, string | undefined> {
  // Undefined if cookie-parser is not installed (see configureApp).
  return (req.cookies as Record<string, string | undefined> | undefined) ?? {};
}

export function sessionCookie(req: Request): string | null {
  return cookies(req)[SESSION_COOKIE] ?? null;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/** Whether the request carries an `X-Device-Id` header that is not a valid device id. */
export function hasMalformedDeviceHeader(req: Request): boolean {
  const header = req.headers[DEVICE_HEADER];
  return header !== undefined && (typeof header !== 'string' || !DEVICE_ID.test(header));
}

/**
 * Device id from the app header, else from the web cookie. A malformed header does not
 * hide a valid cookie: each source is checked on its own.
 */
export function deviceIdOf(req: Request): string | null {
  const header = req.headers[DEVICE_HEADER];
  if (typeof header === 'string' && DEVICE_ID.test(header)) return header;
  const cookie = cookies(req)[DEVICE_COOKIE];
  return cookie !== undefined && DEVICE_ID.test(cookie) ? cookie : null;
}

/** Gives a browser a long-lived random device id if it has none; returns the id. */
export function ensureDeviceCookie(req: Request, res: Response): string {
  const existing = deviceIdOf(req);
  if (existing) return existing;
  const id = randomBytes(24).toString('base64url');
  res.cookie(DEVICE_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
  });
  return id;
}

/**
 * Where the request came from. `deviceId` overrides the header or cookie, for a device
 * cookie issued during this same request.
 */
export function requestMeta(req: Request, deviceId?: string): RequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    // Honors TRUST_PROXY (see configureApp): the client IP, not the proxy's.
    ip: req.ip ?? null,
    deviceId: deviceId ?? deviceIdOf(req),
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}

/** Session cookie: no Max-Age, so it ends with the browser; the server enforces idle expiry. */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isSafeMethod = (method: string) => SAFE_METHODS.has(method.toUpperCase());
