/**
 * Task 8-2's acceptance (doc 19): the WordPress plugin against the real system.
 *
 *   pnpm --filter @sepehr/e2e wordpress:acceptance      (builds must exist: pnpm turbo build)
 *
 * The e2e stack (API on 3100) starts with a random webhook secret held only in this process;
 * a throwaway WordPress (integrations/wordpress/test) gets the plugin. Then:
 *   1. the system unreachable (the plugin pointed at a closed port): a lead sent from the
 *      page waits in the plugin's queue, and the system has nothing;
 *   2. the system reachable again: WP-Cron sends it, and the system has it once, from
 *      WordPress, with its UTM, page and referrer, and the consent in 6-4's ledger;
 *   3. sent again with the same key: still once; a bot (the honeypot): nothing at all.
 * Not in CI: it needs the WordPress images. Exit code 0 only if every check holds.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONTROL_URL, STACK, STACK_DIR } from './stack-config.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const COMPOSE = resolve(ROOT, 'integrations/wordpress/test/docker-compose.yml');
const WP = 'http://localhost:8099';
const SYSTEM = `http://host.docker.internal:${String(STACK.apiPort)}`;
const CLOSED = 'http://host.docker.internal:3999';

const secret = randomBytes(32).toString('hex');
const dbPassword = randomBytes(16).toString('hex');
const composeEnv = { ...process.env, WP_DB_PASSWORD: dbPassword };

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`acceptance failed: ${what}`);
  console.log(`  ✓ ${what}`);
}

function compose(args: string[], input?: string): string {
  const done = spawnSync('docker', ['compose', '-f', COMPOSE, ...args], {
    env: composeEnv,
    encoding: 'utf8',
    input,
  });
  if (done.status !== 0) throw new Error(`docker compose ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
}

const wp = (...args: string[]) => compose(['run', '--rm', '-T', 'cli', ...args, '--quiet']);
const sql = (query: string) =>
  compose(['run', '--rm', '-T', 'cli', 'db', 'query', query, '--skip-column-names']);

async function waitFor(url: string, ok: (status: number) => boolean, what: string) {
  for (let i = 0; i < 600; i++) {
    try {
      if (ok((await fetch(url, { redirect: 'manual' })).status)) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not start`);
}

interface Seen {
  intakes: {
    channel: string;
    utm: Record<string, string> | null;
    pageUrl: string | null;
    referrer: string | null;
    smsConsent: boolean;
  }[];
  consents: { action: string; source: string }[];
}
async function seen(mobile: string): Promise<Seen> {
  const res = await fetch(`${CONTROL_URL}/wordpress-intakes?mobile=${mobile}`);
  if (res.status !== 200) throw new Error(`control: ${String(res.status)}`);
  return (await res.json()) as Seen;
}

/** The form's page as a visitor from Google sees it, then the form posted back. */
async function submit(pageId: string, mobile: string, honeypot = ''): Promise<string> {
  const pageUrl = `${WP}/?page_id=${pageId}&utm_source=google&utm_campaign=wp-acceptance`;
  const page = await fetch(pageUrl, { headers: { referer: 'https://www.google.com/' } });
  const html = await page.text();
  const cookie = page.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const field = (name: string) =>
    // nosemgrep: detect-non-literal-regexp -- test helper; the pattern comes from the test itself
    new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';
  const option = /<option value="([a-z][a-z0-9_]*)">/.exec(html)?.[1] ?? '';
  if (option === '') throw new Error('the form shows no treatment field');
  // A person takes longer than the form's minimum (3 seconds).
  await new Promise((r) => setTimeout(r, 3500));
  const body = new URLSearchParams({
    action: 'sepehr_lead',
    sepehr_lead_nonce: field('sepehr_lead_nonce'),
    sepehr_started: field('sepehr_started'),
    sepehr_page: field('sepehr_page'),
    sepehr_mobile: `0${mobile}`,
    sepehr_field: option,
    sepehr_name: 'آزمون وردپرس',
    sepehr_consent: '1',
    website: honeypot,
  });
  const posted = await fetch(`${WP}/wp-admin/admin-post.php`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  });
  return posted.headers.get('location') ?? '';
}

async function main() {
  if (existsSync(resolve(STACK_DIR, 'ready.json'))) rmSync(resolve(STACK_DIR, 'ready.json'));
  console.log('starting the e2e stack (the system)…');
  const stack = spawn(process.execPath, [resolve(import.meta.dirname, 'stack.ts')], {
    env: { ...process.env, LEAD_WEBHOOK_SECRETS_WORDPRESS: secret },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const stop = () => {
    stack.kill('SIGTERM');
    try {
      compose(['--profile', 'cli', 'down', '-v']);
    } catch {
      // already down
    }
  };
  try {
    await waitFor(`${STACK.webUrl}/`, (s) => s === 200, 'the e2e stack');
    for (let i = 0; i < 600 && !existsSync(resolve(STACK_DIR, 'ready.json')); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log('starting WordPress…');
    compose(['up', '-d', 'db', 'wordpress']);
    await waitFor(`${WP}/wp-admin/install.php`, (s) => s === 200, 'WordPress');
    wp(
      'core',
      'install',
      `--url=${WP}`,
      '--title=sepehr-acceptance',
      '--admin_user=admin',
      `--admin_password=${randomBytes(12).toString('hex')}`,
      '--admin_email=admin@example.test',
      '--skip-email',
    );
    wp('plugin', 'activate', 'sepehr-lead-form');
    const option = (url: string) =>
      wp(
        'option',
        'update',
        'sepehr_lead_form',
        JSON.stringify({ api_url: url, secret }),
        '--format=json',
      );
    const pageId = compose([
      'run',
      '--rm',
      '-T',
      'cli',
      'post',
      'create',
      '--post_type=page',
      '--post_status=publish',
      '--post_title=مشاوره',
      '--post_content=[sepehr_lead_form]',
      '--porcelain',
    ]);

    // The fields list comes from the system once (and is kept), then the system goes away.
    option(SYSTEM);
    check(
      (await (await fetch(`${WP}/?page_id=${pageId}`)).text()).includes('<option value="'),
      'the form lists the treatment fields from the system',
    );
    option(CLOSED);

    const mobile = `912${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    console.log('1. the system unreachable');
    check((await submit(pageId, mobile)).includes('sepehr_lead=ok'), 'the visitor is thanked');
    check(
      sql('SELECT status FROM wp_sepehr_lead_queue') === 'pending',
      'the lead waits in the plugin’s queue',
    );
    check((await seen(mobile)).intakes.length === 0, 'the system has nothing yet');

    console.log('2. the system back');
    option(SYSTEM);
    // Due now, and the plugin's own WP-Cron event, as the schedule would run it.
    sql('UPDATE wp_sepehr_lead_queue SET next_attempt_at = UTC_TIMESTAMP()');
    wp('cron', 'event', 'run', 'sepehr_lead_retry');
    check(sql('SELECT status FROM wp_sepehr_lead_queue') === 'sent', 'the queue row is sent');
    const after = await seen(mobile);
    check(after.intakes.length === 1, 'the system has the lead once');
    const [intake] = after.intakes;
    check(intake?.channel === 'wordpress', 'its source is WordPress');
    check(
      intake?.utm?.['source'] === 'google' && intake.utm['campaign'] === 'wp-acceptance',
      'with its UTM',
    );
    check((intake?.pageUrl ?? '').includes(`page_id=${pageId}`), 'with its page');
    check(intake?.referrer === 'https://www.google.com/', 'with its referrer');
    check(
      intake?.smsConsent === true &&
        after.consents.length === 1 &&
        after.consents[0]?.source === 'wordpress',
      'the consent in 6-4’s ledger, from WordPress',
    );

    console.log('3. never twice; a bot never');
    wp('cron', 'event', 'run', 'sepehr_lead_retry');
    const resent = compose([
      'run',
      '--rm',
      '-T',
      'cli',
      'eval',
      'global $wpdb; $r = $wpdb->get_row("SELECT idempotency_key, body FROM {$wpdb->prefix}sepehr_lead_queue LIMIT 1", ARRAY_A); echo Sepehr_Lead_Client::send($r["body"], $r["idempotency_key"]);',
    ]);
    check(resent === '202', 'the same key again is accepted as a replay');
    check((await seen(mobile)).intakes.length === 1, 'still once in the system');
    const bot = `912${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    check(
      (await submit(pageId, bot, 'http://spam.example')).includes('sepehr_lead=ok'),
      'the bot is thanked like a person',
    );
    check(sql('SELECT COUNT(*) FROM wp_sepehr_lead_queue') === '1', 'but nothing is queued');
    check((await seen(bot)).intakes.length === 0, 'and nothing reaches the system');
    console.log('the WordPress acceptance passed');
  } finally {
    stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause) console.error('cause:', error.cause);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  },
);
