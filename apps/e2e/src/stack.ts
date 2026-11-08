/**
 * The end-to-end stack (task 2-11, part 5): everything real, nothing shared with the local
 * development database. Throwaway Postgres and Redis containers, the database bootstrapped
 * and migrated as in a real environment, the API and the worker from their builds, the
 * data seeded through the API itself, then the web and admin apps on their own ports.
 *
 *   pnpm --filter @sepehr/e2e stack          (builds must exist: pnpm turbo build)
 *
 * Writes .stack/fixture.json (what was seeded) and .stack/otp.json (login codes the
 * worker's development SMS printed), and .stack/owner.json (who started it). Stops everything on
 * Ctrl+C, SIGTERM or POST /stop on the control port (Playwright's global teardown).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { startScanner, startStorage } from './files.ts';
import { seed } from './seed.ts';
import { stagingData, writeAccounts } from './staging-data.ts';
import { STACK, STACK_DIR } from './stack-config.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const API = resolve(ROOT, 'apps/api');

// The images of the API's integration tests, pinned by digest.
const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995';
const REDIS_IMAGE =
  'redis:8-alpine@sha256:bd999b5cfee25fb24b8320a31fddbd69f462df44c8138c66e369582937beebc0';

const children: ChildProcess[] = [];
const secret = () => randomBytes(32).toString('base64');
const password = () => randomBytes(18).toString('base64url');

function withUser(url: string, user: string, pass: string) {
  const u = new URL(url);
  u.username = user;
  u.password = pass;
  return u.toString();
}

function runOnce(script: string, env: NodeJS.ProcessEnv) {
  const done = spawnSync(process.execPath, [script], { cwd: API, env, stdio: 'inherit' });
  if (done.status !== 0) throw new Error(`${script} failed`);
}

function start(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(args[0] ?? '', args.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}] `;
  child.stdout.on('data', (chunk: Buffer) => process.stdout.write(prefix + chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(prefix + chunk.toString()));
  // A service that stops is said, with how (task 9-2: a scan that brought the API down).
  child.on('exit', (code, signal) => {
    process.stderr.write(`${prefix}exited: code ${String(code)}, signal ${String(signal)}
`);
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, ok: (status: number) => boolean, what: string) {
  for (let i = 0; i < 240; i++) {
    try {
      if (ok((await fetch(url, { redirect: 'manual' })).status)) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start`);
}

async function main() {
  mkdirSync(STACK_DIR, { recursive: true });
  // Credit documents (task 3-8) need private storage and the scanner, as in production.
  const [pg, redis, storage, scanner] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
    startStorage(),
    startScanner(),
  ]);
  // Who started this stack: Playwright's webServer, whose global teardown then stops it, or
  // a person, whose stack a test run leaves running (reuseExistingServer).
  writeFileSync(
    resolve(STACK_DIR, 'owner.json'),
    JSON.stringify({
      startedBy: process.env['E2E_STACK_STARTED_BY'] === 'playwright' ? 'playwright' : 'manual',
      pid: process.pid,
    }),
  );
  // Containers removed with their volumes, said outright (owner 1405/07/23); Ryuk is the
  // backstop if this process is killed without running it.
  const stop = async () => {
    for (const child of children) child.kill();
    await Promise.allSettled(
      [pg, redis, storage.container, scanner.container].map((c) => c.stop({ removeVolumes: true })),
    );
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().then(() => process.exit(0));
    });
  }

  const adminUrl = pg.getConnectionUri();
  const passwords = { owner: password(), app: password(), report: password() };
  const base: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
  runOnce('dist/db/cli/bootstrap.js', {
    ...base,
    DB_ADMIN_URL: adminUrl,
    DB_OWNER_PASSWORD: passwords.owner,
    DB_APP_PASSWORD: passwords.app,
    DB_REPORT_PASSWORD: passwords.report,
  });
  runOnce('dist/db/cli/migrate.js', {
    ...base,
    MIGRATION_DATABASE_URL: withUser(adminUrl, 'sepehr_owner', passwords.owner),
  });

  const staging = process.argv.includes('--staging');
  const stagingCode = String(randomInt(100_000, 1_000_000));
  const env: NodeJS.ProcessEnv = {
    ...base,
    DATABASE_URL: withUser(adminUrl, 'sepehr_app', passwords.app),
    REPORTING_DATABASE_URL: withUser(adminUrl, 'sepehr_report', passwords.report),
    REDIS_URL: redis.getConnectionUrl(),
    AUTH_SECRET: secret(),
    FIELD_ENCRYPTION_KEY: secret(),
    BLIND_INDEX_KEY: secret(),
    WEB_ORIGINS: `${STACK.webUrl},${STACK.adminUrl}`,
    // The apps pass the client address on from this machine (X-Forwarded-For).
    TRUST_PROXY: 'loopback',
    // R10 (task 9-3): the internal panel is closed by default. This throwaway stack opens it to
    // every address, since its browsers and ZAP come from many; the closed default and the VPN
    // range are tested in the API's integration tests (access, internal-network).
    INTERNAL_PANEL_CIDRS: '0.0.0.0/0,::/0',
    // Task 9-4 (owner 1405/07/18): the tester's staging signs patients in with one fixed code,
    // new on every run, and sends no real SMS (the worker's printing fake).
    ...(staging ? { DEPLOY_ENV: 'staging', STAGING_FIXED_LOGIN_CODE: stagingCode } : {}),
    PORT: String(STACK.apiPort),
    SMS_PROVIDER: 'fake',
    ...storage.env,
    ...scanner.env,
  };
  start('api', [process.execPath, 'dist/main.js'], API, env);
  await waitFor(`${STACK.apiUrl}/api/v1/auth/me`, (s) => s === 401, 'API');
  const worker = start(
    'worker',
    [process.execPath, 'dist/main.js'],
    resolve(ROOT, 'apps/worker'),
    env,
  );
  // Login codes the development SMS prints, by masked mobile, for the tests to read.
  const codes: Record<string, string> = {};
  const serviceCodes: Record<string, string> = {};
  // Owner 1405/08/10: a new center user's one-time link, by masked mobile, newest.
  const setupLinks: Record<string, string> = {};
  // ADR-052: each financial signature's SMS code, by masked mobile, newest last.
  const stepUpCodes: Record<string, string[]> = {};
  worker.stdout.on('data', (chunk: Buffer) => {
    for (const m of chunk.toString().matchAll(/login code for (\S+): (\d{6})/g)) {
      codes[m[1] ?? ''] = m[2] ?? '';
      writeFileSync(resolve(STACK_DIR, 'otp.json'), JSON.stringify(codes));
    }
    for (const m of chunk.toString().matchAll(/step-up code for (\S+): (\d{6})/g)) {
      (stepUpCodes[m[1] ?? ''] ??= []).push(m[2] ?? '');
      writeFileSync(resolve(STACK_DIR, 'step-up-codes.json'), JSON.stringify(stepUpCodes));
    }
    // Service codes (task 4-7): the code SMS the development console prints ends with it.
    for (const m of chunk.toString().matchAll(/text for (\S+): کد تأیید خدمت.*?(\d{6})\s*$/gm)) {
      serviceCodes[m[1] ?? ''] = m[2] ?? '';
      writeFileSync(resolve(STACK_DIR, 'service-codes.json'), JSON.stringify(serviceCodes));
    }
    for (const m of chunk.toString().matchAll(/text for (\S+): .*?\/setup#([A-Za-z0-9_-]+)/g)) {
      setupLinks[m[1] ?? ''] = m[2] ?? '';
      writeFileSync(resolve(STACK_DIR, 'setup-links.json'), JSON.stringify(setupLinks));
    }
  });

  const fixture = await seed({
    env,
    ownerUrl: withUser(adminUrl, 'sepehr_owner', passwords.owner),
  });
  writeFileSync(resolve(STACK_DIR, 'fixture.json'), JSON.stringify(fixture, null, 2));
  // Task 9-4: the tester's staging, more made-up data and a sheet of every account.
  if (staging) {
    const ownerUrl = withUser(adminUrl, 'sepehr_owner', passwords.owner);
    writeAccounts(fixture, await stagingData({ env, ownerUrl, fixture }), stagingCode);
    console.log(`staging data ready; accounts in ${resolve(STACK_DIR, 'staging-accounts.md')}`);
  }

  // Task 6-9: the tests run the collection unit's nightly cycle as of a later day through this,
  // on 127.0.0.1 only; nothing else is exposed.
  const control = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Task 8-2: what the WordPress acceptance test sent, by one mobile (9XXXXXXXXX only, so
    // nothing but digits reaches the query): its intakes and consents, read only.
    if (req.method === 'GET' && url.pathname === '/wordpress-intakes') {
      const mobile = url.searchParams.get('mobile') ?? '';
      if (!/^9\d{9}$/.test(mobile)) {
        res.writeHead(400).end();
        return;
      }
      const query = `SELECT json_build_object(
          'intakes', (SELECT coalesce(json_agg(json_build_object('channel', channel, 'utm', utm,
            'pageUrl', page_url, 'referrer', referrer, 'smsConsent', sms_consent)), '[]')
            FROM case_intakes WHERE mobile = '${mobile}'),
          'consents', (SELECT coalesce(json_agg(json_build_object('action', action,
            'source', source)), '[]') FROM sms_consents WHERE mobile = '${mobile}'))`;
      void pg
        .exec(['psql', '-U', pg.getUsername(), '-d', pg.getDatabase(), '-At', '-c', query])
        .then((done) => {
          // Closed after each answer: a test waits longer than the keep-alive between two reads.
          res.writeHead(done.exitCode === 0 ? 200 : 500, {
            'content-type': 'application/json',
            connection: 'close',
          });
          res.end(done.output.trim());
        });
      return;
    }
    // The global teardown of a Playwright run that started this stack (owner 1405/07/23): on
    // Windows Playwright ends the webServer without a signal, so the stop is asked for here.
    if (req.method === 'POST' && url.pathname === '/stop') {
      res.writeHead(202, { connection: 'close' }).end();
      void stop().then(() => process.exit(0));
      return;
    }
    // The owner's visual approval (1405/07/23): an identity flag switched on in this throwaway
    // database only, as the seed switches search on, for the re-authentication and
    // required-mobile screenshots. These two keys only; never a path of the acceptance run.
    const VISUAL_FLAGS: Record<string, string> = {
      'identity.reauth': '{"enabled":true,"windowSeconds":300}',
      'identity.staff_mobile_required': '{"enabled":true}',
    };
    const flag = VISUAL_FLAGS[url.searchParams.get('key') ?? ''];
    if (req.method === 'POST' && url.pathname === '/visual-flag' && flag) {
      const key = url.searchParams.get('key') ?? '';
      void pg
        .exec([
          'psql',
          '-U',
          pg.getUsername(),
          '-d',
          pg.getDatabase(),
          '-c',
          `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
           VALUES ('${key}', 'global', '${flag}'::jsonb, now(), 'approved', 'visual approval', now())`,
        ])
        .then((done) => {
          res.writeHead(done.exitCode === 0 ? 204 : 500, { connection: 'close' }).end();
        });
      return;
    }
    // Task 7-5: the reports' views refreshed now, as the worker does every fifteen minutes.
    if (req.method === 'POST' && url.pathname === '/report-refresh') {
      const done = spawnSync(process.execPath, ['dist/modules/reporting/cli/refresh-views.js'], {
        cwd: API,
        env,
        encoding: 'utf8',
      });
      res.writeHead(done.status === 0 ? 200 : 500, { 'content-type': 'text/plain' });
      res.end(done.status === 0 ? done.stdout : done.stderr);
      return;
    }
    const at = url.searchParams.get('at') ?? '';
    if (
      req.method !== 'POST' ||
      url.pathname !== '/collection-cycle' ||
      Number.isNaN(Date.parse(at))
    ) {
      res.writeHead(404).end();
      return;
    }
    const done = spawnSync(
      process.execPath,
      ['dist/modules/collection/cli/run-cycle.js', `--at=${new Date(at).toISOString()}`],
      { cwd: API, env, encoding: 'utf8' },
    );
    res.writeHead(done.status === 0 ? 200 : 500, { 'content-type': 'text/plain' });
    res.end(done.status === 0 ? done.stdout : done.stderr);
  });
  control.listen(3109, '127.0.0.1');

  const next = resolve(ROOT, 'apps/web/node_modules/next/dist/bin/next');
  const appEnv = (origin: string) => ({
    ...process.env,
    NODE_ENV: 'production',
    API_INTERNAL_URL: STACK.apiUrl,
    PUBLIC_WEB_ORIGIN: origin,
    // Task 8-3: the admin's link list names the patient site's addresses.
    PATIENT_WEB_ORIGIN: STACK.webUrl,
  });
  start(
    'web',
    [process.execPath, next, 'start', '--port', String(STACK.webPort)],
    resolve(ROOT, 'apps/web'),
    appEnv(STACK.webUrl),
  );
  start(
    'admin',
    [process.execPath, next, 'start', '--port', String(STACK.adminPort)],
    resolve(ROOT, 'apps/admin'),
    appEnv(STACK.adminUrl),
  );
  await Promise.all([
    waitFor(`${STACK.webUrl}/`, (s) => s === 200, 'web'),
    waitFor(`${STACK.adminUrl}/login`, (s) => s === 200, 'admin'),
  ]);
  writeFileSync(resolve(STACK_DIR, 'ready.json'), JSON.stringify({ at: new Date().toISOString() }));
  console.log(`e2e stack ready: ${STACK.webUrl} and ${STACK.adminUrl}`);
}

main().catch((error: unknown) => {
  console.error('e2e stack failed:', error);
  for (const child of children) child.kill();
  process.exit(1);
});
