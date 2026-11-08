/**
 * Task 9-2 (doc 19): OWASP ZAP, self-hosted, against the local staging (the e2e stack).
 *
 *   pnpm --filter @sepehr/e2e security:zap        (builds must exist: pnpm turbo build)
 *
 * - baseline (passive) on the patient site and the internal panel, unauthenticated;
 * - the API's active scan from its OpenAPI document, once anonymous and once per role with
 *   that role's bearer token (staff: password then TOTP; the patient: the login code), each
 *   capped in time so the 10-minute access token outlives it.
 * Reports (JSON and HTML) in apps/e2e/.stack/zap/. The stack's data is made up (the seed);
 * nothing here touches a real system. The image is pinned by digest (scripts/ci/lib.sh).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  STACK,
  STACK_DIR,
  STAFF_PASSWORD,
  type Fixture,
  type SeededStaff,
} from './stack-config.ts';
import { freshCode } from './totp.ts';

const ZAP_IMAGE =
  'ghcr.io/zaproxy/zaproxy:stable@sha256:7aaa659b0d43078febd82e29bad112285c370727e86ab8340444220e17d9f0d2';
const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(STACK_DIR, 'zap');
const HOST = 'host.docker.internal';
const SCAN_MINUTES = 8;

async function waitFor(url: string, ok: (status: number) => boolean, what: string) {
  for (let i = 0; i < 900; i++) {
    try {
      if (ok((await fetch(url, { redirect: 'manual' })).status)) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not start`);
}

async function post(path: string, body: unknown, bearer?: string) {
  const res = await call(`${STACK.apiUrl}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.9.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}`,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/**
 * fetch, once more on a fresh connection if the pooled one was closed while a scan ran (the
 * API closes idle keep-alive sockets after 5 seconds; undici may still hand one out).
 */
async function call(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : 'error';
    console.log(`  (retrying after: ${cause})`);
    return fetch(url, { ...init, keepalive: false });
  }
}

/** The TOTP step each account used last: a code is never used twice (replay refused). */
const lastSteps = new Map<string, number>();

/** A staff member's bearer token: password, then a TOTP code of a step not yet used. */
async function staffToken(staff: SeededStaff): Promise<string> {
  const login = await post('/auth/staff/login', {
    username: staff.username,
    password: STAFF_PASSWORD,
    client: 'mobile',
  });
  const pending = typeof login.body['accessToken'] === 'string' ? login.body['accessToken'] : '';
  const { code, step } = freshCode(
    staff.totpSecret,
    lastSteps.get(staff.username) ?? staff.lastStep,
  );
  lastSteps.set(staff.username, step);
  const done = await post('/auth/totp/verify', { code }, pending);
  if (done.status !== 200) throw new Error(`staff login failed for a role: ${String(done.status)}`);
  return String(done.body['accessToken']);
}

/** A patient's bearer token through the login code the development SMS printed. */
async function patientToken(mobile: string): Promise<string> {
  const asked = await post('/auth/otp/request', { mobile });
  if (asked.status !== 202) throw new Error(`otp request: ${String(asked.status)}`);
  const masked = `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;
  let code = '';
  for (let i = 0; i < 60 && code === ''; i++) {
    try {
      const codes = JSON.parse(readFileSync(resolve(STACK_DIR, 'otp.json'), 'utf8')) as Record<
        string,
        string
      >;
      code = codes[masked] ?? '';
    } catch {
      code = '';
    }
    if (code === '') await new Promise((r) => setTimeout(r, 500));
  }
  const done = await post('/auth/otp/verify', { mobile, code, client: 'mobile' });
  if (done.status !== 200) throw new Error(`otp verify: ${String(done.status)}`);
  return String(done.body['accessToken']);
}

function zap(args: string[]): number {
  const done = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--add-host',
      `${HOST}:host-gateway`,
      '-v',
      `${OUT}:/zap/wrk:rw`,
      ZAP_IMAGE,
      ...args,
    ],
    { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  return done.status ?? -1;
}

/** ZAP's replacer: the bearer token on every request of the scan. */
const withToken = (token: string) =>
  [
    '-config replacer.full_list(0).description=auth',
    '-config replacer.full_list(0).enabled=true',
    '-config replacer.full_list(0).matchtype=REQ_HEADER',
    '-config replacer.full_list(0).matchstr=Authorization',
    '-config replacer.full_list(0).regex=false',
    `-config replacer.full_list(0).replacement=Bearer\\ ${token}`,
  ].join(' ');

async function main() {
  mkdirSync(OUT, { recursive: true });
  copyFileSync(resolve(ROOT, 'packages/api-client/openapi.json'), resolve(OUT, 'openapi.json'));
  if (existsSync(resolve(STACK_DIR, 'ready.json'))) rmSync(resolve(STACK_DIR, 'ready.json'));
  console.log('starting the e2e stack (local staging)…');
  // The stack's own output (the API's, the worker's) kept beside the reports: a scan that
  // brings a service down is read there.
  const stackLog = createWriteStream(resolve(OUT, 'stack.log'));
  const stack = spawn(process.execPath, [resolve(import.meta.dirname, 'stack.ts')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stack.stdout.pipe(stackLog);
  stack.stderr.pipe(stackLog);
  stack.on('exit', (code, signal) => {
    stackLog.write(`
[security-scan] the stack exited: ${String(code)} ${String(signal)}
`);
  });
  const codes: Record<string, number> = {};
  try {
    await waitFor(`${STACK.webUrl}/`, (s) => s === 200, 'the e2e stack');
    for (let i = 0; i < 900 && !existsSync(resolve(STACK_DIR, 'ready.json')); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    const f = JSON.parse(readFileSync(resolve(STACK_DIR, 'fixture.json'), 'utf8')) as Fixture;

    // `ZAP_ONLY=doctor,accounting` runs those API scans alone (a run cut short, resumed).
    const only = (process.env['ZAP_ONLY'] ?? '').split(',').filter(Boolean);
    const sites = [
      ['web', STACK.webPort],
      ['admin', STACK.adminPort],
    ] as const;
    for (const [name, port] of only.length > 0 ? [] : sites) {
      console.log(`baseline: ${name}`);
      codes[`baseline-${name}`] = zap([
        'zap-baseline.py',
        '-t',
        `http://${HOST}:${String(port)}`,
        '-I',
        '-J',
        `baseline-${name}.json`,
        '-r',
        `baseline-${name}.html`,
      ]);
    }

    const roles: [string, () => Promise<string | null>][] = [
      ['anonymous', () => Promise.resolve(null)],
      // A new patient: the seed's borrowers had a code sent moments ago (its wait applies).
      [
        'patient',
        () => patientToken(`912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`),
      ],
      ['doctor', () => staffToken(f.doctor)],
      ['accounting', () => staffToken(f.finance)],
      ['support', () => staffToken(f.support)],
      ['system-admin', () => staffToken(f.admin)],
    ];
    for (const [role, token] of roles.filter(([r]) => only.length === 0 || only.includes(r))) {
      console.log(`api scan: ${role}`);
      // The API still answering after the last scan: an active scan that brings it down is a
      // finding itself (availability), recorded rather than hidden.
      const alive = await call(`${STACK.apiUrl}/api/v1/auth/me`).then(
        (r) => r.status,
        () => 0,
      );
      console.log(`  API before the scan: ${alive === 401 ? 'up' : `DOWN (${String(alive)})`}`);
      if (alive !== 401) throw new Error('the API is down before this scan');
      const bearer = await token();
      const config = [
        `-config scanner.maxScanDurationInMins=${String(SCAN_MINUTES)}`,
        ...(bearer ? [withToken(bearer)] : []),
      ].join(' ');
      codes[`api-${role}`] = zap([
        'zap-api-scan.py',
        '-t',
        '/zap/wrk/openapi.json',
        '-f',
        'openapi',
        '-O',
        `http://${HOST}:${String(STACK.apiPort)}`,
        '-I',
        '-J',
        `api-${role}.json`,
        '-r',
        `api-${role}.html`,
        '-z',
        config,
      ]);
    }
    writeFileSync(resolve(OUT, 'exit-codes.json'), JSON.stringify(codes, null, 2));
    console.log('ZAP scans done:', codes);
  } finally {
    stack.kill('SIGTERM');
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause) console.error('cause:', error.cause);
    process.exit(1);
  },
);
