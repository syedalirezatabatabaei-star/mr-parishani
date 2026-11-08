/**
 * The employer demo's runtime (docs/decisions/demo-mode-decisions.md): its own compose project
 * (ops/demo), its secrets kept in ops/demo/secrets, the shared clock, and the API, worker and
 * web apps run with the clock preload. Nothing here touches the development stack or its data.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

export const ROOT = resolve(import.meta.dirname, '../../../..');
export const API = resolve(ROOT, 'apps/api');
export const DEMO_DIR = resolve(ROOT, 'ops/demo');
const COMPOSE = resolve(DEMO_DIR, 'docker-compose.demo.yml');
const SECRETS_DIR = resolve(DEMO_DIR, 'secrets');
// Each database its own seed state and printed codes.
export const STATE_DIR = resolve(
  SECRETS_DIR,
  process.env['DEMO_DATABASE'] ? `state-${process.env['DEMO_DATABASE']}` : 'state',
);
export const CLOCK_FILE = resolve(DEMO_DIR, 'clock/faketimerc');
const PRELOAD = pathToFileURL(resolve(DEMO_DIR, 'clock-preload.mjs')).href;
export const SNAPSHOT_ROOT = 'D:\\sepehr_app\\demo-snapshots';

export const PORTS = {
  api: 3200,
  web: 3201,
  admin: 3202,
  postgres: 5442,
  redis: 6389,
  s3: 8343,
  clamav: 3320,
  /** The demo's sign-in proxy (totp-proxy.ts), only with `pnpm demo:2fa off`. */
  totpProxy: 3203,
};
export const URLS = {
  api: `http://127.0.0.1:${String(PORTS.api)}`,
  web: `http://localhost:${String(PORTS.web)}`,
  admin: `http://localhost:${String(PORTS.admin)}`,
};
export const BUCKETS = { private: 'sepehr-private', public: 'sepehr-public' } as const;
/**
 * The demo database. DEMO_DATABASE names another one in the same container, for building the
 * seed itself: made new (CREATE DATABASE), so a failed try never needs the demo's emptied.
 */
export const DATABASE = process.env['DEMO_DATABASE'] ?? 'sepehr_demo';

export interface Secrets {
  pgAdmin: string;
  owner: string;
  app: string;
  report: string;
  auth: string;
  field: string;
  blind: string;
  s3Access: string;
  s3Secret: string;
  /** The patients' fixed login code (DEPLOY_ENV=staging), the same on every start. */
  patientCode: string;
  /** The one password of every staff and center account of the demo (rule 29: not in code). */
  staffPassword: string;
}

/** Made once, then the same on every start: a snapshot opens only with the keys it was made with. */
export function secrets(): Secrets {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(resolve(DEMO_DIR, 'clock'), { recursive: true });
  const file = resolve(SECRETS_DIR, 'demo.json');
  const adminFile = resolve(SECRETS_DIR, 'pg-admin-password');
  if (existsSync(file)) {
    const kept = JSON.parse(readFileSync(file, 'utf8')) as Partial<Secrets> &
      Omit<Secrets, 'staffPassword'>;
    if (kept.staffPassword) return kept as Secrets;
    // A secrets file of before the password moved here: one added, the rest kept.
    const added = { ...kept, staffPassword: `Demo-${randomBytes(9).toString('base64url')}` };
    writeFileSync(file, JSON.stringify(added, null, 2));
    return added;
  }
  const b64 = () => randomBytes(32).toString('base64');
  const word = () => randomBytes(18).toString('base64url');
  const made: Secrets = {
    pgAdmin: existsSync(adminFile) ? readFileSync(adminFile, 'utf8').trim() : word(),
    owner: word(),
    app: word(),
    report: word(),
    auth: b64(),
    field: b64(),
    blind: b64(),
    s3Access: randomBytes(12).toString('hex'),
    s3Secret: randomBytes(24).toString('hex'),
    patientCode: String(randomInt(100_000, 1_000_000)),
    staffPassword: `Demo-${randomBytes(9).toString('base64url')}`,
  };
  writeFileSync(adminFile, made.pgAdmin);
  writeFileSync(file, JSON.stringify(made, null, 2));
  return made;
}

// --- the clock -------------------------------------------------------------------------

const realNow = () => {
  // The seed runs with the preload; the real time is the shifted one minus the offset.
  return Date.now() - clockOffsetSeconds() * 1000;
};

export function clockOffsetSeconds(): number {
  try {
    const n = Number(readFileSync(CLOCK_FILE, 'utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Moves the whole demo stack's "now" to `at` (forward only once services run). */
export async function setClock(at: Date | 'real') {
  const offset = at === 'real' ? 0 : Math.round((at.getTime() - realNow()) / 1000);
  writeFileSync(CLOCK_FILE, offset >= 0 ? `+${String(offset)}` : String(offset));
  // Both readers re-read at most twice a second.
  await new Promise((r) => setTimeout(r, 1200));
}

// --- docker ----------------------------------------------------------------------------

export function compose(args: string[], quiet = false) {
  const done = spawnSync('docker', ['compose', '-f', COMPOSE, ...args], {
    cwd: DEMO_DIR,
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
  });
  if (done.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed${quiet ? `: ${done.stderr}` : ''}`);
  }
  return done.stdout;
}

/** psql inside the demo database container, as its administrator. */
export function psql(sql: string, database = DATABASE): string {
  const done = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'demo_admin',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      sql,
    ],
    { cwd: DEMO_DIR, encoding: 'utf8' },
  );
  if (done.status !== 0) throw new Error(`psql failed: ${done.stderr.trim()}`);
  return done.stdout.trim();
}

/**
 * Whether something on the host port answers the opening line (`hello`) at all. After Docker
 * stops all at once, a container can come back healthy while Docker Desktop's forwarding of its
 * port closes every connection at once, unanswered (1405/08/10).
 */
export function answers(port: number, hello: string | Buffer, ms = 5000): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    const end = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      done(ok);
    };
    const timer = setTimeout(() => {
      end(false);
    }, ms);
    socket.once('connect', () => socket.write(hello));
    socket.once('data', () => {
      end(true);
    });
    socket.once('close', () => {
      end(false);
    });
    socket.once('error', () => {
      end(false);
    });
  });
}

// Postgres's SSLRequest (answered with one byte), Redis's PING, a bare HTTP request, clamd's PING.
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const PORT_PROBES = [
  { service: 'postgres', port: PORTS.postgres, hello: SSL_REQUEST },
  { service: 'redis', port: PORTS.redis, hello: 'PING\r\n' },
  { service: 'seaweedfs', port: PORTS.s3, hello: 'HEAD / HTTP/1.0\r\n\r\n' },
  { service: 'clamav', port: PORTS.clamav, hello: 'zPING\0' },
];

/** The message for services whose containers are up but whose host ports hang up. */
export function portsMessage(dead: readonly { service: string; port: number; name: string }[]) {
  return [
    `کانتینر ${dead.map((d) => `${d.service} (درگاه ${String(d.port)})`).join('، ')} بالاست، ولی درگاهش روی این رایانه اتصال را بی‌پاسخ می‌بندد.`,
    'این معمولاً پس از خاموشی یا ری‌استارت ناگهانی Docker پیش می‌آید: انتقال درگاه Docker خراب مانده و داده سالم است.',
    'این دستور را اجرا و دوباره pnpm demo:up کنید (کانتینر و volume حذف نمی‌شوند):',
    `  docker restart ${dead.map((d) => d.name).join(' ')}`,
  ].join('\n');
}

/** Every service reachable from the host, or the exact restart that brings it back. */
async function checkPorts() {
  const dead = [];
  for (const probe of PORT_PROBES) if (!(await answers(probe.port, probe.hello))) dead.push(probe);
  if (dead.length === 0) return;
  const names = new Map(
    compose(['ps', '--format', '{{.Service}} {{.Name}}'], true)
      .trim()
      .split('\n')
      .map((line) => line.trim().split(' ') as [string, string]),
  );
  throw new Error(
    portsMessage(
      dead.map((d) => ({ ...d, name: names.get(d.service) ?? `sepehr-demo-${d.service}-1` })),
    ),
  );
}

export async function containersUp() {
  secrets();
  if (!existsSync(CLOCK_FILE)) writeFileSync(CLOCK_FILE, '+0');
  compose(['up', '-d', '--wait'], true);
  await checkPorts();
  if (
    DATABASE !== 'sepehr_demo' &&
    psql(`SELECT count(*) FROM pg_database WHERE datname = '${DATABASE}'`, 'postgres') === '0'
  ) {
    psql(`CREATE DATABASE ${DATABASE}`, 'postgres');
  }
}

// --- the database and storage ----------------------------------------------------------

const withUser = (user: string, pass: string, database = DATABASE) =>
  `postgres://${user}:${encodeURIComponent(pass)}@127.0.0.1:${String(PORTS.postgres)}/${database}`;

export function urls(s = secrets()) {
  return {
    admin: withUser('demo_admin', s.pgAdmin),
    owner: withUser('sepehr_owner', s.owner),
    app: withUser('sepehr_app', s.app),
    report: withUser('sepehr_report', s.report),
  };
}

function runApiCli(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const done = spawnSync(process.execPath, ['--import', PRELOAD, script, ...args], {
    cwd: API,
    env,
    encoding: 'utf8',
  });
  if (done.status !== 0)
    throw new Error(`${script} failed: ${done.stderr.trim() || done.stdout.trim()}`);
  return done.stdout.trim();
}

/** Roles (rotated to the kept passwords) and every migration; both repeatable. */
export function prepareDatabase() {
  const s = secrets();
  const u = urls(s);
  const base = { ...process.env, NODE_ENV: 'development' };
  runApiCli('dist/db/cli/bootstrap.js', {
    ...base,
    DB_ADMIN_URL: u.admin,
    DB_OWNER_PASSWORD: s.owner,
    DB_APP_PASSWORD: s.app,
    DB_REPORT_PASSWORD: s.report,
  });
  runApiCli('dist/db/cli/migrate.js', { ...base, MIGRATION_DATABASE_URL: u.owner });
}

export function s3Client(s = secrets()) {
  return new S3Client({
    endpoint: `http://127.0.0.1:${String(PORTS.s3)}`,
    region: 'us-east-1',
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: s.s3Access, secretAccessKey: s.s3Secret },
  });
}

export async function ensureBuckets() {
  const client = s3Client();
  for (const bucket of Object.values(BUCKETS)) {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') break;
        if (attempt >= 60) throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  client.destroy();
}

// --- the services ----------------------------------------------------------------------

export function serviceEnv(): NodeJS.ProcessEnv {
  const s = secrets();
  const u = urls(s);
  const s3 = `http://127.0.0.1:${String(PORTS.s3)}`;
  return {
    ...process.env,
    NODE_ENV: 'development',
    NODE_OPTIONS: `--import ${PRELOAD}`,
    DEMO_CLOCK_FILE: CLOCK_FILE,
    DATABASE_URL: u.app,
    REPORTING_DATABASE_URL: u.report,
    MIGRATION_DATABASE_URL: u.owner,
    REDIS_URL: `redis://127.0.0.1:${String(PORTS.redis)}`,
    AUTH_SECRET: s.auth,
    FIELD_ENCRYPTION_KEY: s.field,
    BLIND_INDEX_KEY: s.blind,
    WEB_ORIGINS: `${URLS.web},${URLS.admin}`,
    TRUST_PROXY: 'loopback',
    // The internal panel from this machine only (the stack's 0.0.0.0/0 is not copied).
    INTERNAL_PANEL_CIDRS: '127.0.0.1/32,::1/128',
    DEPLOY_ENV: 'staging',
    STAGING_FIXED_LOGIN_CODE: s.patientCode,
    PORT: String(PORTS.api),
    SMS_PROVIDER: 'fake',
    S3_ENDPOINT: s3,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: s.s3Access,
    S3_SECRET_KEY: s.s3Secret,
    S3_PRIVATE_BUCKET: BUCKETS.private,
    S3_PUBLIC_BUCKET: BUCKETS.public,
    S3_PUBLIC_BASE_URL: `${s3}/${BUCKETS.public}`,
    CLAMAV_HOST: '127.0.0.1',
    CLAMAV_PORT: String(PORTS.clamav),
  };
}

/** A CLI of the API run as the worker would, on the demo clock. */
export function apiCli(script: string, args: string[] = []) {
  return runApiCli(script, serviceEnv(), args);
}

const children: ChildProcess[] = [];

function start(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: boolean) {
  const child = spawn(args[0] ?? '', args.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}] `;
  // Always read: a full pipe blocks the child (Nest's start-up log alone fills one).
  child.stdout.on('data', (c: Buffer) => {
    if (log) process.stdout.write(prefix + c.toString());
  });
  child.stderr.on('data', (c: Buffer) => process.stderr.write(prefix + c.toString()));
  child.on('exit', (code, signal) => {
    if (!stopping)
      process.stderr.write(`${prefix}exited: code ${String(code)}, signal ${String(signal)}\n`);
  });
  children.push(child);
  return child;
}

let stopping = false;

export function stopServices() {
  stopping = true;
  for (const child of children) child.kill();
  children.length = 0;
}

async function waitFor(url: string, ok: (status: number) => boolean, what: string) {
  for (let i = 0; i < 480; i++) {
    try {
      const status = (await fetch(url, { redirect: 'manual' })).status;
      if (ok(status)) return;
      if (process.env['DEMO_DEBUG'] && i % 20 === 0) console.error(`${what}: ${String(status)}`);
    } catch (error) {
      // not listening yet
      if (process.env['DEMO_DEBUG'] && i % 20 === 0)
        console.error(`${what}: ${String(error)} ${String((error as { cause?: unknown }).cause)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start`);
}

/** The development SMS the worker prints, kept by masked mobile for the seed (and the show). */
function watchCodes(worker: ChildProcess) {
  const files = { otp: 'otp.json', stepUp: 'step-up-codes.json', service: 'service-codes.json' };
  const read = (f: string) => {
    try {
      return JSON.parse(readFileSync(resolve(STATE_DIR, f), 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const codes = read(files.otp) as Record<string, string>;
  const stepUp = read(files.stepUp) as Record<string, string[]>;
  const service = read(files.service) as Record<string, string>;
  const log = resolve(STATE_DIR, 'sms.log');
  worker.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (line.includes('[dev sms]')) writeFileSync(log, `${line.trim()}\n`, { flag: 'a' });
    }
    for (const m of text.matchAll(/login code for (\S+): (\d{6})/g)) {
      codes[m[1] ?? ''] = m[2] ?? '';
      writeFileSync(resolve(STATE_DIR, files.otp), JSON.stringify(codes));
    }
    for (const m of text.matchAll(/step-up code for (\S+): (\d{6})/g)) {
      (stepUp[m[1] ?? ''] ??= []).push(m[2] ?? '');
      writeFileSync(resolve(STATE_DIR, files.stepUp), JSON.stringify(stepUp));
    }
    for (const m of text.matchAll(/text for (\S+): کد تأیید خدمت.*?(\d{6})\s*$/gm)) {
      service[m[1] ?? ''] = m[2] ?? '';
      writeFileSync(resolve(STATE_DIR, files.service), JSON.stringify(service));
    }
  });
}

/**
 * The API and the worker; with `apps`, the two web apps too (the show), sending their API calls
 * to `appsApi` when given (the demo's sign-in proxy), else to the API itself.
 */
export async function startServices(options: { apps: boolean; log: boolean; appsApi?: string }) {
  stopping = false;
  const env = serviceEnv();
  start('api', [process.execPath, 'dist/main.js'], API, env, options.log);
  await waitFor(`${URLS.api}/api/v1/auth/me`, (s) => s === 401, 'API');
  const worker = start(
    'worker',
    [process.execPath, 'dist/main.js'],
    resolve(ROOT, 'apps/worker'),
    env,
    options.log,
  );
  watchCodes(worker);
  if (!options.apps) return;
  const next = resolve(ROOT, 'apps/web/node_modules/next/dist/bin/next');
  const appEnv = (origin: string) => ({
    ...process.env,
    NODE_ENV: 'production',
    NODE_OPTIONS: `--import ${PRELOAD}`,
    DEMO_CLOCK_FILE: CLOCK_FILE,
    API_INTERNAL_URL: options.appsApi ?? URLS.api,
    PUBLIC_WEB_ORIGIN: origin,
    PATIENT_WEB_ORIGIN: URLS.web,
  });
  start(
    'web',
    [process.execPath, next, 'start', '--hostname', '127.0.0.1', '--port', String(PORTS.web)],
    resolve(ROOT, 'apps/web'),
    appEnv(URLS.web),
    options.log,
  );
  start(
    'admin',
    [process.execPath, next, 'start', '--hostname', '127.0.0.1', '--port', String(PORTS.admin)],
    resolve(ROOT, 'apps/admin'),
    appEnv(URLS.admin),
    options.log,
  );
  await Promise.all([
    waitFor(`http://127.0.0.1:${String(PORTS.web)}/`, (s) => s === 200, 'web'),
    waitFor(`http://127.0.0.1:${String(PORTS.admin)}/login`, (s) => s === 200, 'admin'),
  ]);
}

export function portsBusy(): boolean {
  const probe = spawnSync(process.execPath, [
    '-e',
    `require('net').createServer().once('error',()=>process.exit(1)).listen(${String(PORTS.api)},'::',function(){this.close(()=>process.exit(0))})`,
  ]);
  return probe.status !== 0;
}
