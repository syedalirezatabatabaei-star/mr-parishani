/**
 * The demo's staff: every role of the system (docs/guides/roles), two separate people for each
 * two-person task, made-up Persian names. The first administrator comes from the CLI, as on a
 * real install; every other account and grant goes through the API.
 */
import { spawnSync } from 'node:child_process';
import { call } from '../../seed.ts';
import { freshCode } from '../../totp.ts';
import { resolve } from 'node:path';
import { API, DEMO_DIR, serviceEnv } from '../runtime.ts';
import { as, demoPassword, person, type Person, type SeedState } from './context.ts';

interface Planned {
  key: string;
  username: string;
  name: string;
  kind?: 'staff' | 'center';
  roles: { code: string; scope: Record<string, unknown> }[];
}

const g = { kind: 'global' };
const R = (code: string, scope: Record<string, unknown> = g) => ({ code, scope });

/** Every staff role, and the two custom roles the two-person patient-mobile paths need. */
export const STAFF: Planned[] = [
  { key: 'admin1', username: 'admin.rahimi', name: 'بهرام رحیمی', roles: [R('system_admin')] },
  { key: 'admin2', username: 'admin.sadeghi', name: 'نسرین صادقی', roles: [R('system_admin')] },
  {
    key: 'tech',
    username: 'tech.approver',
    name: 'پویا نیک‌نام',
    roles: [R('technical_config_approver')],
  },
  { key: 'ceo', username: 'ceo.amini', name: 'دکتر فرهاد امینی', roles: [R('ceo')] },
  { key: 'deputy', username: 'deputy.kazemi', name: 'شیرین کاظمی', roles: [R('holiday_deputy')] },
  {
    key: 'third',
    username: 'third.approver',
    name: 'حمید توکلی',
    roles: [R('mobile_change_approver')],
  },
  {
    key: 'netspec1',
    username: 'network.isfahan',
    name: 'الهام شریفی',
    roles: [R('network_specialist', { kind: 'city', code: 'isfahan' })],
  },
  // Only Isfahan is a city of the system today (0020); Kashan's centers are in Isfahan's scope.
  {
    key: 'netspec2',
    username: 'network.isfahan2',
    name: 'مجید قمصری',
    roles: [R('network_specialist', { kind: 'city', code: 'isfahan' })],
  },
  {
    key: 'netman1',
    username: 'network.manager1',
    name: 'رضا یزدانی',
    roles: [R('network_manager')],
  },
  {
    key: 'netman2',
    username: 'network.manager2',
    name: 'مریم فاطمی',
    roles: [R('network_manager')],
  },
  { key: 'strat1', username: 'strategy.a', name: 'کاوه بهمنی', roles: [R('strategy_manager')] },
  { key: 'strat2', username: 'strategy.b', name: 'لیلا مستوفی', roles: [R('strategy_manager')] },
  { key: 'comp1', username: 'completion.a', name: 'سارا جهانگیری', roles: [R('case_completion')] },
  { key: 'comp2', username: 'completion.b', name: 'علیرضا نادری', roles: [R('case_completion')] },
  {
    key: 'compfin',
    username: 'completion.finance',
    name: 'زهره مقدم',
    roles: [R('case_completion'), R('accounting')],
  },
  {
    key: 'credspec1',
    username: 'credit.analyst1',
    name: 'محسن کریمی',
    roles: [R('credit_specialist')],
  },
  {
    key: 'credspec2',
    username: 'credit.analyst2',
    name: 'نگین حسینی',
    roles: [R('credit_specialist')],
  },
  {
    key: 'credman1',
    username: 'credit.manager1',
    name: 'داوود اصفهانی',
    roles: [R('credit_manager')],
  },
  {
    key: 'credman2',
    username: 'credit.manager2',
    name: 'فرزانه طاهری',
    roles: [R('credit_manager')],
  },
  {
    key: 'committee1',
    username: 'committee.strategy',
    name: 'ناصر رستگار',
    roles: [R('credit_committee'), R('strategy_manager')],
  },
  {
    key: 'committee2',
    username: 'committee.collection',
    name: 'پروین عسگری',
    roles: [R('credit_committee'), R('collection')],
  },
  { key: 'acc1', username: 'finance.a', name: 'مهدی نوروزی', roles: [R('accounting')] },
  { key: 'acc2', username: 'finance.b', name: 'آزاده رفیعی', roles: [R('accounting')] },
  { key: 'acc3', username: 'finance.c', name: 'سعید لطفی', roles: [R('accounting')] },
  { key: 'coll1', username: 'collection.a', name: 'امیر جعفری', roles: [R('collection')] },
  { key: 'coll2', username: 'collection.b', name: 'فاطمه صالحی', roles: [R('collection')] },
  {
    key: 'collman',
    username: 'collection.manager',
    name: 'حسن موسوی',
    roles: [R('collection_manager')],
  },
  { key: 'support1', username: 'support.a', name: 'مینا رضایی', roles: [R('support')] },
  { key: 'support2', username: 'support.b', name: 'یاسر قاسمی', roles: [R('support')] },
  {
    key: 'advisor1',
    username: 'advisor.a',
    name: 'نیلوفر کرمانی',
    roles: [R('advisor', { kind: 'own' })],
  },
  {
    key: 'advisor2',
    username: 'advisor.b',
    name: 'بابک شجاعی',
    roles: [R('advisor', { kind: 'own' })],
  },
  { key: 'club', username: 'club.officer', name: 'هانیه زمانی', roles: [R('club_officer')] },
  { key: 'auditor', username: 'auditor', name: 'جواد فرهمند', roles: [R('auditor')] },
  {
    key: 'release',
    username: 'release.requester',
    name: 'ساره دهقان',
    roles: [R('release_requester')],
  },
  {
    key: 'mobappr1',
    username: 'mobile.approver1',
    name: 'کامران وحیدی',
    roles: [R('mobile_approver')],
  },
  {
    key: 'mobappr2',
    username: 'mobile.approver2',
    name: 'شهلا ابراهیمی',
    roles: [R('mobile_approver')],
  },
  {
    key: 'mobappr3',
    username: 'mobile.approver3',
    name: 'رامین فروتن',
    roles: [R('mobile_approver')],
  },
  {
    key: 'mobchg1',
    username: 'mobile.changer1',
    name: 'اکبر صفایی',
    roles: [R('patient_mobile_changer')],
  },
  {
    key: 'mobchg2',
    username: 'mobile.changer2',
    name: 'طاهره نجفی',
    roles: [R('patient_mobile_changer')],
  },
];

const REASON = 'نمونه دمو';

function cli(script: string, env: Record<string, string>) {
  const done = spawnSync(process.execPath, [script], {
    cwd: API,
    env: { ...serviceEnv(), ...env },
    encoding: 'utf8',
  });
  if (done.status !== 0) throw new Error(`${script}: ${done.stderr.trim() || done.stdout.trim()}`);
  return done.stdout;
}

type Plain = { key: string; username: string; name: string; kind?: 'staff' | 'center' };

/**
 * Accounts made by the same service as `pnpm account:create`, one process for the whole list
 * (ops/demo/create-accounts.cjs); each then signs in and enrolls TOTP through the API, as its
 * owner would at first login.
 */
export async function createAccounts(
  plans: Plain[],
  options: { admin?: Person; onMade?: (who: Person) => void } = {},
): Promise<Person[]> {
  if (plans.length === 0) return [];
  // An account a stopped try made is looked up, not made twice (its TOTP is enrolled below).
  const ids: Record<string, string> = {};
  if (options.admin) {
    for (const plan of plans) {
      const found = await as(
        options.admin,
        'GET',
        `/access/accounts/by-username/${encodeURIComponent(plan.username)}`,
      ).catch(() => null);
      if (typeof found?.['id'] === 'string') ids[plan.username] = found['id'];
    }
  }
  const missing = plans.filter((p) => !ids[p.username]);
  if (missing.length > 0) {
    const done = spawnSync(process.execPath, [resolve(DEMO_DIR, 'create-accounts.cjs')], {
      cwd: API,
      env: { ...serviceEnv(), ACCOUNT_PASSWORD: demoPassword() },
      input: JSON.stringify(
        missing.map((p) => ({ kind: p.kind ?? 'staff', username: p.username })),
      ),
      encoding: 'utf8',
    });
    if (done.status !== 0) throw new Error(`create-accounts: ${done.stderr.trim()}`);
    Object.assign(ids, JSON.parse(done.stdout) as Record<string, string>);
  }
  const people: Person[] = [];
  for (const plan of plans) {
    const accountId = ids[plan.username];
    if (!accountId) throw new Error(`no account id for ${plan.username}`);
    const login = await call('POST', '/auth/staff/login', undefined, {
      username: plan.username,
      password: demoPassword(),
      client: 'mobile',
    });
    const pending = String(login['accessToken']);
    const enroll = await call('POST', '/auth/totp/enroll', pending);
    const totpSecret = String(enroll['secret']);
    const { step, code } = freshCode(totpSecret, 0);
    const verified = await call('POST', '/auth/totp/verify', pending, { code });
    const who: Person = {
      key: plan.key,
      username: plan.username,
      name: plan.name,
      kind: plan.kind ?? 'staff',
      roles: [],
      accountId,
      totpSecret,
      lastStep: step,
      token: String(verified['accessToken']),
    };
    options.onMade?.(who);
    people.push(who);
  }
  return people;
}

export async function grant(
  admin: Person,
  who: Person,
  code: string,
  scope: Record<string, unknown>,
) {
  await as(admin, 'POST', '/access/assignments', {
    accountId: who.accountId,
    roleCode: code,
    scope,
    reason: REASON,
  });
  who.roles.push(code);
}

/** Every staff account and its roles; repeatable (made ones are kept in the state). */
export async function seedStaff(state: SeedState) {
  const first = STAFF[0];
  if (!first) throw new Error('no staff planned');
  if (!state.people[first.key]) {
    const [admin] = await createAccounts([first]);
    if (!admin) throw new Error('no first administrator');
    cli('dist/modules/access/cli/grant-role.js', {
      ACCOUNT_ID: admin.accountId,
      ROLE_CODE: 'system_admin',
      GRANT_REASON: `${REASON}: مدیر اول سامانه`,
    });
    admin.roles.push('system_admin');
    state.people[first.key] = admin;
  }
  const admin = person(state, first.key);
  // The two custom roles of the two-person patient-mobile paths (the staging seed's).
  const roles = (await as(admin, 'GET', '/access/roles')) as unknown as { code: string }[];
  const have = new Set(
    (Array.isArray(roles) ? roles : ((roles as { items?: { code: string }[] }).items ?? [])).map(
      (r) => r.code,
    ),
  );
  if (!have.has('mobile_approver')) {
    await as(admin, 'POST', '/access/roles', {
      code: 'mobile_approver',
      name: 'تأیید شماره بیمار',
      permissions: ['lead.approve_person_mobile'],
      reason: REASON,
    });
  }
  if (!have.has('patient_mobile_changer')) {
    await as(admin, 'POST', '/access/roles', {
      code: 'patient_mobile_changer',
      name: 'تغییر شماره بیمار',
      permissions: ['identity.change_patient_mobile'],
      reason: REASON,
    });
  }
  const todo = STAFF.slice(1).filter((plan) => !state.people[plan.key]);
  const made = await createAccounts(todo);
  for (const [i, who] of made.entries()) {
    for (const r of todo[i]?.roles ?? []) await grant(admin, who, r.code, r.scope);
    state.people[who.key] = who;
  }
}
