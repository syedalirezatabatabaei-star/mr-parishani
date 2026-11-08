/**
 * The demo's sign-in without typing a TOTP code (owner 1405/08/09; demo only, off unless
 * `pnpm demo:2fa off`). It sits between the two web apps and the demo API, on 127.0.0.1, and
 * passes every request through unchanged except the staff and center login: after a correct
 * password it passes the account's TOTP itself, through the API's own /auth/totp/verify (the
 * replay check, the counters and the audit all as usual), with the secret the seed kept in
 * the demo's ignored state folder. The API, its guards and its contract are not touched; no
 * image carries this folder (Dockerfile: `pnpm deploy --prod` of each app).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { resolve } from 'node:path';
import { freshCode } from '../totp.ts';
import { DEMO_DIR, PORTS, STATE_DIR } from './runtime.ts';

// Beside the secrets, not in the state folder: demo:reset empties that, and a reset is no
// reason to change how people sign in.
const FLAG = () => resolve(DEMO_DIR, 'secrets', '2fa.json');
const LOGIN = '/api/v1/auth/staff/login';
const VERIFY = '/api/v1/auth/totp/verify';

/** Whether the demo asks for the TOTP code; asked (on) unless `pnpm demo:2fa off`. */
export function totpRequired(): boolean {
  try {
    return (JSON.parse(readFileSync(FLAG(), 'utf8')) as { required?: unknown }).required !== false;
  } catch {
    return true;
  }
}

export function setTotpRequired(required: boolean) {
  writeFileSync(FLAG(), JSON.stringify({ required }, null, 2));
}

/** The seed's TOTP secret of each staff and center username. */
function secretOf(username: string): string | null {
  const file = resolve(STATE_DIR, 'seed-state.json');
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, 'utf8')) as {
    people?: Record<string, { username?: string; totpSecret?: string }>;
  };
  const who = Object.values(state.people ?? {}).find((p) => p.username === username);
  return who?.totpSecret ?? null;
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function forward(method: string, path: string, headers: IncomingHttpHeaders, body?: Buffer) {
  return new Promise<Answer>((done, fail) => {
    const out = request({ host: '127.0.0.1', port: PORTS.api, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        done({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', fail);
    });
    out.on('error', fail);
    out.end(body);
  });
}

const cookiePairs = (setCookie: string[] | undefined) =>
  (setCookie ?? []).map((c) => c.split(';')[0] ?? '').filter(Boolean);
const cookieName = (c: string) => c.split('=')[0] ?? '';

// The last step used per username here, so two sign-ins in one half-minute take the next.
const lastSteps = new Map<string, number>();

/** The login, then the TOTP passed for it; any failure leaves the login as the API gave it. */
async function login(headers: IncomingHttpHeaders, body: Buffer): Promise<Answer> {
  const first = await forward('POST', LOGIN, headers, body);
  if (first.status !== 200 || totpRequired()) return first;
  let input: { username?: unknown };
  let answer: Record<string, unknown>;
  try {
    input = JSON.parse(body.toString('utf8')) as { username?: unknown };
    answer = JSON.parse(first.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return first;
  }
  const username = typeof input.username === 'string' ? input.username : '';
  const secret = secretOf(username);
  const csrf = answer['csrfToken'];
  if (answer['next'] !== 'totp' || !secret || typeof csrf !== 'string') return first;

  // The API takes one step ahead at most, so a third sign-in in one half-minute waits for the
  // next step rather than guessing (a wrong code counts towards the lock). Only a step the API
  // accepted is kept: a refused one moved this further ahead every time.
  const { step, code } = freshCode(secret, lastSteps.get(username) ?? 0);
  const wait = (step - 1) * 30_000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const given = cookiePairs(first.headers['set-cookie']);
  const kept = (headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !given.some((g) => cookieName(g) === cookieName(c)));
  const payload = Buffer.from(JSON.stringify({ code }));
  const second = await forward(
    'POST',
    VERIFY,
    {
      ...headers,
      cookie: [...kept, ...given].join('; '),
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      'content-length': String(payload.length),
    },
    payload,
  );
  if (second.status !== 200) return first;
  lastSteps.set(username, step);
  const verified = JSON.parse(second.body.toString('utf8')) as Record<string, unknown>;
  // The pending session's cookie is replaced by the verified one; the device cookie stays.
  const after = second.headers['set-cookie'] ?? [];
  const names = new Set(cookiePairs(after).map(cookieName));
  const cookies = [
    ...(first.headers['set-cookie'] ?? []).filter((c) => !names.has(cookieName(c))),
    ...after,
  ];
  const merged = Buffer.from(JSON.stringify({ ...answer, ...verified }));
  return {
    status: 200,
    headers: {
      ...first.headers,
      'set-cookie': cookies,
      'content-length': String(merged.length),
    },
    body: merged,
  };
}

/** Starts the proxy, on 127.0.0.1 only; `pnpm demo:up` alone starts it, with the flag off. */
export function startTotpProxy(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    if (method === 'POST' && path.split('?')[0] === LOGIN) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        login(req.headers, Buffer.concat(chunks))
          .then((a) => {
            res.writeHead(a.status, a.headers);
            res.end(a.body);
          })
          .catch(() => {
            res.writeHead(502);
            res.end();
          });
      });
      return;
    }
    // Everything else streamed through as it is (uploads, downloads, the rest).
    const out = request(
      { host: '127.0.0.1', port: PORTS.api, method, path, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(out);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      done(server);
    });
  });
}
