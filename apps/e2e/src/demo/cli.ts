/**
 * `pnpm demo:<command>` (docs/decisions/demo-mode-decisions.md). up | down | status | seed |
 * reset | snapshot [name] | restore <name> | 2fa [on|off]. reset and restore empty the demo database
 * (owner 1405/08/07: typed confirmation every time); nothing outside the sepehr-demo project.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  BUCKETS,
  clockOffsetSeconds,
  compose,
  containersUp,
  DATABASE,
  ensureBuckets,
  portsBusy,
  prepareDatabase,
  psql,
  s3Client,
  setClock,
  SNAPSHOT_ROOT,
  startServices,
  STATE_DIR,
  stopServices,
  PORTS,
  URLS,
} from './runtime.ts';
import { setTotpRequired, startTotpProxy, totpRequired } from './totp-proxy.ts';

const [command, arg] = process.argv.slice(2);

async function confirm(what: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${what}\nبرای ادامه DEMO را تایپ کنید: `);
  rl.close();
  if (answer.trim() !== 'DEMO') throw new Error('لغو شد (DEMO تایپ نشد)');
}

function refuseWhileRunning() {
  if (portsBusy())
    throw new Error('demo:up در حال اجراست (درگاه ۳۲۰۰). اول آن را با Ctrl+C ببندید.');
}

async function emptyStorage() {
  const client = s3Client();
  for (const bucket of Object.values(BUCKETS)) {
    for (;;) {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (page.Contents ?? []).map((o) => o.Key ?? '').filter(Boolean);
      if (keys.length === 0) break;
      for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
    }
  }
  client.destroy();
}

/** The demo database dropped and made again, its Redis and buckets emptied. */
async function emptyEverything() {
  psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid()`,
    'postgres',
  );
  psql(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`, 'postgres');
  psql(`CREATE DATABASE ${DATABASE}`, 'postgres');
  compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL'], true);
  await ensureBuckets();
  await emptyStorage();
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });
}

function count(sql: string) {
  try {
    return psql(sql);
  } catch {
    return '—';
  }
}

function status() {
  const rows: [string, string][] = [
    ['ساعت دمو (جابه‌جایی، ثانیه)', String(clockOffsetSeconds())],
    ['مهاجرت‌ها', count('SELECT count(*) FROM drizzle.__drizzle_migrations')],
    [
      'حساب‌ها (کارمند، مرکز، بیمار)',
      count(
        "SELECT string_agg(kind || ' ' || n, '، ') FROM (SELECT kind, count(*) n FROM user_accounts GROUP BY kind ORDER BY kind) x",
      ),
    ],
    ['مراکز', count('SELECT count(*) FROM centers WHERE deleted_at IS NULL')],
    ['پزشکان', count('SELECT count(*) FROM doctors WHERE deleted_at IS NULL')],
    ['اشخاص (بیمار)', count('SELECT count(*) FROM persons')],
    ['نوبت‌ها', count('SELECT count(*) FROM appointments')],
    ['پیش‌فاکتورها', count('SELECT count(*) FROM proformas')],
    [
      'پرونده‌های اعتباری بر حسب وضعیت',
      count(
        "SELECT string_agg(status || ' ' || n, '، ') FROM (SELECT status, count(*) n FROM credit_applications GROUP BY status ORDER BY status) x",
      ),
    ],
    ['ردیف‌های دفتر کل', count('SELECT count(*) FROM ledger_entries')],
    [
      'سند نامتوازن',
      count(
        "SELECT count(*) FROM (SELECT journal_entry_id FROM ledger_entries GROUP BY 1 HAVING sum(CASE WHEN direction = 'debit' THEN amount_rial ELSE -amount_rial END) <> 0) x",
      ),
    ],
    [
      'جمع بدهکار = جمع بستانکار',
      count(
        "SELECT (sum(amount_rial) FILTER (WHERE direction = 'debit') = sum(amount_rial) FILTER (WHERE direction = 'credit'))::text FROM ledger_entries",
      ),
    ],
    [
      'گردش دفتر کل (ریال، بدهکار)',
      count("SELECT coalesce(sum(amount_rial), 0) FROM ledger_entries WHERE direction = 'debit'"),
    ],
    ['تیکت‌ها', count('SELECT count(*) FROM tickets')],
  ];
  for (const [k, v] of rows) console.log(`${k}: ${v}`);
}

async function snapshot(name: string) {
  const dir = join(SNAPSHOT_ROOT, name);
  if (existsSync(dir)) throw new Error(`snapshot ${name} هست؛ نام دیگری بدهید`);
  mkdirSync(join(dir, 'storage'), { recursive: true });
  const started = performance.now();
  const dump = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      resolve(import.meta.dirname, '../../../../ops/demo/docker-compose.demo.yml'),
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      'demo_admin',
      '-Fc',
      DATABASE,
    ],
    { maxBuffer: 2 ** 31 },
  );
  if (dump.status !== 0) throw new Error(`pg_dump failed: ${dump.stderr.toString()}`);
  writeFileSync(join(dir, 'sepehr_demo.dump'), dump.stdout);
  const client = s3Client();
  let files = 0;
  for (const bucket of Object.values(BUCKETS)) {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }));
        const target = join(dir, 'storage', bucket, o.Key ?? '');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          Buffer.from((await got.Body?.transformToByteArray()) ?? new Uint8Array()),
        );
        files++;
      }
      token = page.NextContinuationToken;
    } while (token);
  }
  client.destroy();
  for (const f of ['otp.json', 'service-codes.json', 'step-up-codes.json', 'seed-state.json']) {
    const from = join(STATE_DIR, f);
    if (existsSync(from)) writeFileSync(join(dir, f), readFileSync(from));
  }
  writeFileSync(join(dir, 'clock'), String(clockOffsetSeconds()));
  console.log(
    `snapshot ${name}: ${dir} (${String(files)} فایل ذخیره‌ساز، ${String(Math.round((performance.now() - started) / 1000))} ثانیه)`,
  );
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

async function restore(name: string) {
  const dir = join(SNAPSHOT_ROOT, name);
  if (!existsSync(join(dir, 'sepehr_demo.dump')))
    throw new Error(`snapshot ${name} پیدا نشد در ${SNAPSHOT_ROOT}`);
  refuseWhileRunning();
  await confirm(`همه داده فعلی دمو پاک و snapshot «${name}» جایگزین می‌شود.`);
  const started = performance.now();
  await containersUp();
  await emptyEverything();
  const restored = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      resolve(import.meta.dirname, '../../../../ops/demo/docker-compose.demo.yml'),
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'demo_admin',
      '-d',
      DATABASE,
      '--exit-on-error',
    ],
    { input: readFileSync(join(dir, 'sepehr_demo.dump')), maxBuffer: 2 ** 28 },
  );
  if (restored.status !== 0) throw new Error(`pg_restore failed: ${restored.stderr.toString()}`);
  const client = s3Client();
  const root = join(dir, 'storage');
  if (existsSync(root)) {
    for (const file of walk(root)) {
      const rel = file.slice(root.length + 1).split(/[\\/]/);
      const bucket = rel.shift() ?? '';
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: rel.join('/'), Body: readFileSync(file) }),
      );
    }
  }
  client.destroy();
  for (const f of ['otp.json', 'service-codes.json', 'step-up-codes.json', 'seed-state.json']) {
    if (existsSync(join(dir, f))) writeFileSync(join(STATE_DIR, f), readFileSync(join(dir, f)));
  }
  await setClock('real');
  console.log(`restore ${name}: ${String(Math.round((performance.now() - started) / 1000))} ثانیه`);
}

async function main() {
  switch (command) {
    case 'up': {
      refuseWhileRunning();
      await containersUp();
      prepareDatabase();
      await ensureBuckets();
      // `pnpm demo:2fa off` (owner 1405/08/09): the two panels sign in with the password alone.
      const proxy = totpRequired() ? null : await startTotpProxy(PORTS.totpProxy);
      await startServices({
        apps: true,
        log: arg === '--log',
        ...(proxy ? { appsApi: `http://127.0.0.1:${String(PORTS.totpProxy)}` } : {}),
      });
      console.log(
        `\nدمو آماده است:\n  وب بیمار و پنل مرکز: ${URLS.web}  (${URLS.web}/panel/login)\n  پنل داخلی: ${URLS.admin}/login\n  برگه حساب‌ها: docs/demo/demo-accounts.md\n  کدهای پیامک: ops/demo/secrets/state/sms.log\nبستن برنامه‌ها: Ctrl+C (داده می‌ماند). بستن پایگاه‌ها: pnpm demo:down
  ورود کارکنان و مراکز: ${proxy ? 'فقط رمز (pnpm demo:2fa on برای TOTP)' : 'رمز و TOTP'}`,
      );
      const stop = () => {
        proxy?.close();
        stopServices();
        process.exit(0);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await new Promise(() => undefined);
      break;
    }
    case 'down':
      refuseWhileRunning();
      compose(['stop'], true);
      console.log('کانتینرهای دمو متوقف شدند (حذف نشدند؛ داده می‌ماند).');
      break;
    case 'status':
      await containersUp();
      status();
      break;
    case 'snapshot':
      await containersUp();
      await snapshot(arg ?? `snap-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
      break;
    case 'restore':
      if (!arg) throw new Error('usage: pnpm demo:restore <name>');
      await restore(arg);
      break;
    case 'reset': {
      refuseWhileRunning();
      await confirm(
        `همه داده دمو (پایگاه ${DATABASE}، Redis و فایل‌های دمو) پاک و حساب‌های پایه دوباره ساخته می‌شوند.`,
      );
      const started = performance.now();
      await containersUp();
      await emptyEverything();
      prepareDatabase();
      const { resetBase } = await import('./seed/index.ts');
      await resetBase();
      console.log(`reset: ${String(Math.round((performance.now() - started) / 1000))} ثانیه`);
      break;
    }
    case 'seed': {
      refuseWhileRunning();
      const started = performance.now();
      await containersUp();
      prepareDatabase();
      await ensureBuckets();
      const { seedAll } = await import('./seed/index.ts');
      const { loadState } = await import('./seed/context.ts');
      await seedAll();
      console.log(`seed: ${String(Math.round((performance.now() - started) / 1000))} ثانیه`);
      const issues = (loadState().data['issues'] as string[] | undefined) ?? [];
      console.log(
        `seed: ${String(issues.length)} ایراد ثبت‌شده (ops/demo/secrets/state*/seed-state.json، data.issues)`,
      );
      // A snapshot of the seeded demo, so it comes back without seeding again (demo:restore).
      // A seed resumed the same day keeps the earlier snapshot and takes one with the hour.
      const day = `seeded-${new Date().toISOString().slice(0, 10)}-${DATABASE}`;
      const hour = new Date().toISOString().slice(11, 16).replace(':', '');
      await snapshot(existsSync(resolve(SNAPSHOT_ROOT, day)) ? `${day}-${hour}` : day);
      break;
    }
    case '2fa': {
      if (arg === 'on' || arg === 'off') setTotpRequired(arg === 'on');
      else if (arg !== undefined) throw new Error('usage: pnpm demo:2fa [on|off]');
      const required = totpRequired();
      console.log(
        required
          ? 'TOTP دمو: روشن (ورود با رمز و کد). اگر دمو روشن است، از ورود بعدی اثر دارد.'
          : `TOTP دمو: خاموش (ورود فقط با رمز).${portsBusy() ? ' دمو روشن است؛ اگر با TOTP روشن شده بود، یک بار Ctrl+C و pnpm demo:up.' : ''}`,
      );
      break;
    }
    default:
      console.log(
        'usage: pnpm demo:<up|down|status|seed|reset|snapshot [name]|restore <name>|2fa [on|off]>',
      );
      process.exitCode = 2;
  }
}

main()
  .then(() => {
    if (command !== 'up') process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    stopServices();
    console.error('demo:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
