/**
 * The demo seed's order (docs/decisions/demo-mode-decisions.md). Each phase is recorded in
 * ops/demo/secrets/state/seed-state.json when done, so `demo:seed` run again goes on from the
 * first phase not done and makes nothing twice. The whole stack runs on the demo clock: the
 * seed starts six months back and moves forward; at the end the clock is real again.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  apiCli,
  clockOffsetSeconds,
  compose,
  psql,
  ROOT,
  secrets,
  setClock,
  startServices,
  stopServices,
  URLS,
} from '../runtime.ts';
import { seedStaff, STAFF } from './base.ts';
import { demoPassword, loadState, saveState, type SeedState } from './context.ts';

/** The seed's first day: 09:00 Tehran, 183 days before today (the real today). */
export function startOfHistory(): Date {
  const real = new Date(Date.now() - clockOffsetSeconds() * 1000);
  const day = new Date(real.getTime() - 183 * 86_400_000);
  // 09:00 Tehran is 05:30 UTC.
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 5, 30));
}

type Phase = { name: string; run: (state: SeedState) => Promise<void> };

async function phases(): Promise<Phase[]> {
  const { seedSettings } = await import('./settings.ts');
  const { seedCatalog } = await import('./catalog.ts');
  const { seedTimeline } = await import('./timeline.ts');
  const { seedContracts } = await import('./contracts.ts');
  const { seedExtras } = await import('./extras.ts');
  const { seedPortal } = await import('./portal.ts');
  return [
    { name: 'staff', run: seedStaff },
    { name: 'settings', run: seedSettings },
    { name: 'catalog', run: seedCatalog },
    { name: 'contracts', run: seedContracts },
    { name: 'timeline', run: seedTimeline },
    { name: 'extras', run: seedExtras },
    // Owner 1405/08/11: the portal's sample banners, pages and announcement (migration 0110).
    { name: 'portal', run: seedPortal },
  ];
}

export function writeAccounts(state: SeedState) {
  const s = secrets();
  const roleName: Record<string, string> = {};
  for (const line of psql("SELECT code || '|' || name FROM roles").split('\n')) {
    const [code, name] = line.split('|');
    if (code) roleName[code] = name ?? code;
  }
  const people = Object.values(state.people);
  const row = (p: (typeof people)[number]) =>
    `| ${p.name} | \`${p.username}\` | ${p.roles.map((r) => roleName[r] ?? r).join('، ') || '—'} | \`${p.totpSecret}\` |`;
  const staff = people.filter((p) => p.kind === 'staff');
  const center = people.filter((p) => p.kind === 'center');
  const patients = state.patients;
  const text = [
    '# حساب‌های دمو (نمونه دمو)',
    '',
    '> داده ساختگی. **این فایل در مخزن نمی‌آید** (`.gitignore`). هیچ شماره، نام بیمار یا کد ملی واقعی نیست.',
    '',
    `- **وب بیمار:** ${URLS.web} — **پنل مرکز و پزشک:** ${URLS.web}/panel/login — **پنل داخلی:** ${URLS.admin}/login`,
    `- **رمز همه کارکنان و حساب‌های مرکز:** \`${demoPassword()}\``,
    '- **عامل دوم:** راز TOTP هر نفر را در برنامه authenticator وارد کنید (۳۰ ثانیه، ۶ رقم، SHA-1).',
    `- **کد ورود همه بیماران (ثابت در این دمو):** \`${s.patientCode}\`. هیچ پیامک واقعی نمی‌رود؛ کدهای دیگر در \`ops/demo/secrets/state/sms.log\`.`,
    '',
    `## کارکنان (${String(staff.length)})`,
    '',
    '| نام (ساختگی) | نام کاربری | نقش | راز TOTP |',
    '|---|---|---|---|',
    ...staff.map(row),
    '',
    `## مراکز و پزشکان (${String(center.length)})`,
    '',
    '| نام | نام کاربری | نقش | راز TOTP |',
    '|---|---|---|---|',
    ...center.map(row),
    '',
    `## بیماران (${String(patients.length)})`,
    '',
    '| نام (ساختگی) | موبایل | شهر | داستان |',
    '|---|---|---|---|',
    ...patients.map((p) => `| ${p.name} | \`0${p.mobile}\` | ${p.city} | ${p.story ?? ''} |`),
    '',
  ].join('\n');
  writeFileSync(resolve(ROOT, 'docs/demo/demo-accounts.md'), text);
}

async function run(only: string[] | null) {
  const state = loadState();
  const todo = (await phases()).filter(
    (p) => !state.phases.includes(p.name) && (!only || only.includes(p.name)),
  );
  if (todo.length === 0) {
    console.log('همه مرحله‌های seed پیش‌تر انجام شده‌اند.');
    return state;
  }
  // The seed goes on where its clock stopped (six months back at first). Its Redis holds only
  // the queues' schedules, made again by the worker from that "now"; emptied first, so a
  // schedule made later on the real clock does not wait months on the seed's.
  compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL'], true);
  const at = Math.max(startOfHistory().getTime(), Number(state.data['clockAt'] ?? 0));
  await setClock(new Date(at));
  // The monthly partitions (audit, outbox, ledger…) of the seed's months: the worker's own
  // daily maintenance, run once on the demo clock.
  console.log(`seed: ${apiCli('dist/infra/ops/cli/partitions.js')}`);
  await startServices({ apps: false, log: false });
  try {
    for (const phase of todo) {
      const started = performance.now();
      console.log(`seed: ${phase.name}…`);
      await phase.run(state);
      state.phases.push(phase.name);
      state.data['clockAt'] = Date.now();
      saveState(state);
      writeAccounts(state);
      console.log(
        `seed: ${phase.name} (${String(Math.round((performance.now() - started) / 1000))} ثانیه)`,
      );
    }
  } catch (error) {
    saveState(state);
    throw error;
  } finally {
    stopServices();
  }
  return state;
}

/** reset: the staff only (the database is empty before this). */
export async function resetBase() {
  await run(['staff']);
  await setClock('real');
}

export async function seedAll() {
  await run(null);
  await setClock('real');
  console.log(`seed: ${String(STAFF.length)} کارمند؛ برگه حساب‌ها در docs/demo/demo-accounts.md`);
}
