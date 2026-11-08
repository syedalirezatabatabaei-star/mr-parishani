import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './openapi.js';

/**
 * The one way the web and admin apps talk to the API (task 2-11), generated from the API's
 * OpenAPI document (CLAUDE.md §5): `openapi.json` is written by `pnpm --filter @sepehr/api
 * openapi` from the NestJS routes and the Zod schemas of @sepehr/contracts, and
 * `src/openapi.ts` by `pnpm --filter @sepehr/api-client generate`. Paths, parameters,
 * bodies and answers are all typed from it.
 *
 * In the browser the base URL is empty: requests go to the app's own origin (`/api/v1`),
 * which Next.js rewrites to the API, so the `__Host-` session cookie and the Origin check
 * work with no CORS. On the server, pages call the API directly and pass the cookie on.
 */

/** An error answer of the API (`{ error, issues? }`), or a failure to reach it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues: readonly { path: string; message: string }[] = [],
    readonly body: unknown = null,
  ) {
    super(`${String(status)} ${code}`);
    this.name = 'ApiError';
  }

  get notFound() {
    return this.status === 404;
  }

  /** Where a `moved` answer points (an old slug, say), or null. */
  get location(): string | null {
    const body = this.body as { location?: unknown } | null;
    return typeof body?.location === 'string' ? body.location : null;
  }

  /** Seconds to wait after a 429, when the API says. */
  get retryAfterSeconds(): number | null {
    const body = this.body as { retryAfterSeconds?: unknown } | null;
    return typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : null;
  }

  get unauthenticated() {
    return this.status === 401;
  }
}

export interface ApiClientOptions {
  /** '' in the browser (same origin); `API_INTERNAL_URL` on the server. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Extra headers on every request, e.g. the visitor's cookie on the server. */
  readonly headers?: () => Readonly<Record<string, string>>;
  /** The session's CSRF token, sent on every state-changing request. */
  readonly csrfToken?: () => string | null;
}

export type ApiClient = Client<paths>;

const SAFE = new Set(['GET', 'HEAD']);

export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  client.use({
    onRequest({ request }) {
      for (const [name, value] of Object.entries(options.headers?.() ?? {})) {
        request.headers.set(name, value);
      }
      if (!SAFE.has(request.method)) {
        const csrf = options.csrfToken?.();
        if (csrf) request.headers.set('x-csrf-token', csrf);
      }
      return request;
    },
  });
  return client;
}

interface Answer<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

/**
 * The body of a successful answer; any other answer becomes an {@link ApiError}: the API's
 * own error code, a redirect not followed (`moved`, with its location), or `network_error`.
 *
 *   const me = await unwrap(api.GET('/api/v1/auth/me'));
 */
export async function unwrap<T>(call: Promise<Answer<T>>): Promise<T> {
  let answer: Answer<T>;
  try {
    answer = await call;
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'network_error');
  }
  const { response } = answer;
  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(response.status, 'moved', [], {
      location: response.headers.get('location'),
    });
  }
  if (!response.ok) {
    const error = answer.error as { error?: unknown; issues?: unknown } | string | undefined;
    const body = typeof error === 'object' ? error : null;
    throw new ApiError(
      response.status,
      typeof body?.error === 'string' ? body.error : `http_${String(response.status)}`,
      Array.isArray(body?.issues) ? (body.issues as { path: string; message: string }[]) : [],
      error ?? null,
    );
  }
  return answer.data as T;
}
