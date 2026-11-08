import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { describe, expect, it, vi } from 'vitest';
import { authApi } from './auth.js';
import { ApiError, createApiClient, unwrap } from './client.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(response: Response | (() => Promise<Response>), csrf: string | null = 'tok') {
  const fetch = vi.fn<(request: Request) => Promise<Response>>(
    typeof response === 'function' ? response : () => Promise.resolve(response),
  );
  const api = createApiClient({
    baseUrl: 'http://api.test',
    fetch: fetch as unknown as typeof globalThis.fetch,
    csrfToken: () => csrf,
    headers: () => ({ cookie: '__Host-sid=x' }),
  });
  const request = () => {
    const sent = fetch.mock.calls[0]?.[0];
    if (!sent) throw new Error('nothing was sent');
    return sent;
  };
  return { api, request };
}

/**
 * Regenerating the client parses and prints the whole document (2.4 MB in task 9-3, from
 * 1.1 MB in phase 6): about 0.85 s alone, CPU-bound. Under turbo's full run (two `next build`s
 * and some thirty tasks at once) it passed Vitest's default 5 s (ب۶). The work is the
 * assertion itself, so the time limit is raised, never the check: see task-9-3-r1-r2-decisions.
 */
const REGENERATE_TIMEOUT_MS = 30_000;

describe('generated from the OpenAPI document (CLAUDE.md §5)', () => {
  it(
    'src/openapi.ts is what openapi-typescript makes of openapi.json (`pnpm generate`)',
    async () => {
      const spec = new URL('../openapi.json', import.meta.url);
      const generated = astToString(await openapiTS(spec));
      const committed = readFileSync(
        fileURLToPath(new URL('./openapi.ts', import.meta.url)),
        'utf8',
      );
      const body = (text: string) => text.slice(text.indexOf('export interface paths'));
      expect(body(committed)).toBe(body(generated));
    },
    REGENERATE_TIMEOUT_MS,
  );
});

describe('createApiClient', () => {
  it('GET: the typed path and query, the extra headers, no CSRF token', async () => {
    const { api, request } = client(json(200, { items: [] }));
    await unwrap(
      api.GET('/api/v1/search/doctors', { params: { query: { q: 'علی', cityCode: 'tehran' } } }),
    );
    expect(request().url).toBe(
      'http://api.test/api/v1/search/doctors?q=%D8%B9%D9%84%DB%8C&cityCode=tehran',
    );
    expect(request().headers.get('cookie')).toBe('__Host-sid=x');
    expect(request().headers.get('x-csrf-token')).toBeNull();
  });

  it('POST: JSON body and the CSRF token', async () => {
    const { api, request } = client(json(202, { expiresInSeconds: 120, resendAfterSeconds: 60 }));
    await unwrap(api.POST('/api/v1/auth/otp/request', { body: { mobile: '9121234567' } }));
    expect(request().method).toBe('POST');
    expect(await request().text()).toBe('{"mobile":"9121234567"}');
    expect(request().headers.get('content-type')).toBe('application/json');
    expect(request().headers.get('x-csrf-token')).toBe('tok');
  });

  it('an API error keeps its code, issues and retry time', async () => {
    const { api } = client(
      json(400, { error: 'invalid_request', issues: [{ path: 'mobile', message: 'bad' }] }),
    );
    const error = await unwrap(
      api.POST('/api/v1/auth/otp/request', { body: { mobile: 'x' } }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' });
    expect((error as ApiError).issues).toEqual([{ path: 'mobile', message: 'bad' }]);

    const { api: limited } = client(json(429, { error: 'resend_too_soon', retryAfterSeconds: 42 }));
    const tooSoon = (await unwrap(
      limited.POST('/api/v1/auth/otp/request', { body: { mobile: 'x' } }),
    ).catch((e: unknown) => e)) as ApiError;
    expect(tooSoon.retryAfterSeconds).toBe(42);
  });

  it('an error with no JSON body gets an http_ code', async () => {
    const { api } = client(new Response('Bad Gateway', { status: 502 }));
    await expect(unwrap(api.GET('/api/v1/auth/me'))).rejects.toMatchObject({
      status: 502,
      code: 'http_502',
    });
  });

  it('a redirect not followed is thrown as moved, with its location', async () => {
    const { api, request } = client(
      new Response(null, { status: 301, headers: { location: '/api/v1/public/doctors/new' } }),
    );
    const error = (await unwrap(
      api.GET('/api/v1/public/doctors/{slug}', {
        params: { path: { slug: 'old' } },
        redirect: 'manual',
      }),
    ).catch((e: unknown) => e)) as ApiError;
    expect(request().redirect).toBe('manual');
    expect(error).toMatchObject({ status: 301, code: 'moved' });
    expect(error.location).toBe('/api/v1/public/doctors/new');
  });

  it('a network failure is an ApiError, not a raw TypeError', async () => {
    const { api } = client(() => Promise.reject(new TypeError('failed')));
    await expect(unwrap(api.GET('/api/v1/auth/me'))).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });
});

describe('authApi', () => {
  it('normalizes the mobile and digits before sending (rules 23, 24)', async () => {
    const { api, request } = client(json(200, { stage: 'active', csrfToken: 't' }));
    await authApi(api).verifyOtp({ mobile: '۰۹۱۲ ۱۲۳ ۴۵۶۷', code: '۱۲۳۴۵۶' });
    expect(JSON.parse(await request().text())).toEqual({
      mobile: '9121234567',
      code: '123456',
      client: 'web',
    });
  });

  it('refuses a bad mobile before any request', () => {
    const { api } = client(json(202, {}));
    expect(() => authApi(api).requestOtp({ mobile: '123' })).toThrow();
  });
});
