import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginFor, PATH_HEADER, signInAgain } from './login-gate';

// The request as serverApi sees it, and the API's answer to /auth/me.
const request = vi.hoisted(() => ({
  path: null as string | null,
  cookie: true,
  me: (): Promise<unknown> => Promise.resolve({ stage: 'active' }),
}));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      has: () => request.cookie,
      toString: () => (request.cookie ? '__Host-sid=old' : ''),
    }),
  headers: () =>
    Promise.resolve({ get: (name: string) => (name === PATH_HEADER ? request.path : null) }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}));
vi.mock('@sepehr/api-client', async (original) => ({
  ...(await original<typeof import('@sepehr/api-client')>()),
  authApi: () => ({ me: () => request.me(), access: () => Promise.resolve({ permissions: [] }) }),
}));

const { ApiError } = await import('@sepehr/api-client');
const { serverApi } = await import('./server-api');

describe('login gate', () => {
  it('names the sign-in page of each gated area, none for public and sign-in pages', () => {
    expect(loginFor('/me/repayment')).toBe('/login');
    expect(loginFor('/book/0190')).toBe('/login');
    expect(loginFor('/panel/dashboard')).toBe('/panel/login');
    expect(loginFor('/panel/login')).toBeNull();
    expect(loginFor('/login')).toBeNull();
    expect(loginFor('/search')).toBeNull();
    expect(loginFor('/doctors/x')).toBeNull();
    expect(loginFor('/media/x')).toBeNull();
  });

  it('sends back to sign in only a refused cookie on a gated page, with the way back', () => {
    expect(signInAgain('/book/0190?at=2026-11-01T10:00', true, false)).toBe(
      '/login?next=%2Fbook%2F0190%3Fat%3D2026-11-01T10%3A00',
    );
    expect(signInAgain('/panel/settlement', true, false)).toBe(
      '/panel/login?next=%2Fpanel%2Fsettlement',
    );
    expect(signInAgain('/book/0190', true, true)).toBeNull();
    expect(signInAgain('/book/0190', false, false)).toBeNull();
    expect(signInAgain('/search', true, false)).toBeNull();
    expect(signInAgain(null, true, false)).toBeNull();
  });
});

describe('serverApi with a session cookie the API no longer takes', () => {
  beforeEach(() => {
    request.path = null;
    request.cookie = true;
    request.me = () => Promise.resolve({ stage: 'active' });
  });

  it.each(['/book/0190', '/me/repayment', '/me/contracts/12', '/me/credit'])(
    '%s: to the sign-in and back, not a failed call on the page',
    async (path) => {
      request.path = path;
      request.me = () => Promise.reject(new ApiError(401, 'not_authenticated'));
      await expect(serverApi()).rejects.toThrow(
        `NEXT_REDIRECT /login?next=${encodeURIComponent(path)}`,
      );
    },
  );

  it('a live session, a public page or no cookie: the API, no redirect', async () => {
    request.path = '/me/repayment';
    await expect(serverApi()).resolves.toBeDefined();
    request.path = '/search';
    request.me = () => Promise.reject(new ApiError(401, 'not_authenticated'));
    await expect(serverApi()).resolves.toBeDefined();
    request.path = '/me/repayment';
    request.cookie = false;
    await expect(serverApi()).resolves.toBeDefined();
  });

  it('an API that cannot answer is no reason to sign in again', async () => {
    request.path = '/me/repayment';
    request.me = () => Promise.reject(new ApiError(503, 'unavailable'));
    await expect(serverApi()).resolves.toBeDefined();
  });
});
