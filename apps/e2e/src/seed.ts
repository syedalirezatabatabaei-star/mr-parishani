/**
 * What the end-to-end stack starts with, made through the API as people would (the same
 * steps as the API's integration tests): staff with TOTP, an active center with its
 * manager, a doctor with a priced visit, weekly hours and a published profile, and the
 * search on. Only the first administrator and the feature flag are written from outside
 * the API: the CLI, as on a real first install, and one config row in this throwaway
 * database (as the integration tests do).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { addJalaliMonths, gregorianDayOf, toJalali } from '@sepehr/contracts';
import pg from 'pg';
import {
  STACK,
  STACK_DIR,
  STAFF_PASSWORD,
  type Fixture,
  type SeededStaff,
} from './stack-config.ts';
import { codeFor, fundedPurse } from './seed-funded.ts';
import { digits, nationalId, sheba } from './synthetic.ts';
import { freshCode } from './totp.ts';

const API_DIR = resolve(import.meta.dirname, '../../api');
const reason = { reason: 'داده آزمون انتهابه‌انتها' };

type Body = Record<string, unknown>;

export interface Staff extends SeededStaff {
  readonly token: string;
}

/**
 * ADR-052: the owner's database for this stack, where a signer's own mobile is recorded the
 * first time they sign (set once by {@link seed}).
 */
let stepUpOwnerUrl: string | null = null;
/** Seed signers' mobiles: 9179 then a counter, so no two masked numbers are alike. */
let signerMobiles = 0;
const typedCodes = new Set<string>();

const sleep = (ms: number) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/**
 * ADR-052: signs a financial request as its staff member would. Their own verified mobile
 * (recorded here once, in this throwaway database), a code asked for this operation, and the
 * code the worker's development SMS printed for that mobile (.stack/step-up-codes.json).
 */
async function stepUpProof(token: string, operation: unknown): Promise<string> {
  if (!stepUpOwnerUrl) throw new Error('step-up asked before the seed set its database');
  const me = await call('GET', '/auth/me', token);
  const accountId = me['accountId'] as string;
  const db = new pg.Client({ connectionString: stepUpOwnerUrl });
  await db.connect();
  let mobile: string;
  try {
    const { rows } = await db.query<{ mobile: string | null; verified: boolean }>(
      'SELECT mobile, mobile_verified_at IS NOT NULL AS verified FROM user_accounts WHERE id = $1',
      [accountId],
    );
    const row = rows[0];
    if (row?.mobile && row.verified) {
      mobile = row.mobile;
    } else {
      signerMobiles += 1;
      mobile = `9179${String(signerMobiles).padStart(6, '0')}`;
      await db.query(
        'UPDATE user_accounts SET mobile = $2, mobile_verified_at = now() WHERE id = $1',
        [accountId, mobile],
      );
    }
  } finally {
    await db.end();
  }
  const sent = await call('POST', '/identity/step-up/challenges', token, operation);
  const masked = `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;
  for (let i = 0; i < 100; i += 1) {
    let codes: Record<string, string[]> = {};
    try {
      codes = JSON.parse(readFileSync(resolve(STACK_DIR, 'step-up-codes.json'), 'utf8')) as Record<
        string,
        string[]
      >;
    } catch {
      // Not written yet.
    }
    const code = [...(codes[masked] ?? [])]
      .reverse()
      .find((c) => !typedCodes.has(`${masked}:${c}`));
    if (code) {
      typedCodes.add(`${masked}:${code}`);
      return `${sent['challengeId'] as string}.${code}`;
    }
    await sleep(200);
  }
  throw new Error(`step-up: no code printed for ${masked}`);
}

/**
 * One API call. A socket the API closed while idle (its keep-alive is 5 s; the CLI steps
 * take longer) fails before any answer: that request never reached the API, so it is sent
 * once more on a new connection. A financial request answered `step_up_required` is signed
 * with its SMS code and sent again (ADR-052).
 */
export async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  proof?: string,
): Promise<Body> {
  const send = () =>
    fetch(`${STACK.apiUrl}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(proof ? { 'x-step-up': proof } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let res: Response;
  try {
    res = await send();
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code !== 'UND_ERR_SOCKET') throw error;
    res = await send();
  }
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as Body;
  if (res.status === 403 && json['error'] === 'step_up_required' && token && !proof) {
    return call(method, path, token, body, await stepUpProof(token, json['operation']));
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)} ${text}`);
  return json;
}

function cli(script: string, env: NodeJS.ProcessEnv): string {
  const done = spawnSync(process.execPath, [script], { cwd: API_DIR, env, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`${script}: ${done.stderr}`);
  return done.stdout;
}

/** A staff or center account from the CLI, signed in on the mobile client (tokens). */
export async function account(env: NodeJS.ProcessEnv, kind: 'staff' | 'center', name: string) {
  const username = `${name}_${randomBytes(3).toString('hex')}`;
  const out = cli('dist/modules/identity/cli/create-account.js', {
    ...env,
    ACCOUNT_KIND: kind,
    ACCOUNT_USERNAME: username,
    ACCOUNT_PASSWORD: STAFF_PASSWORD,
  });
  const accountId = /account created: (\S+)/.exec(out)?.[1] ?? '';
  const login = await call('POST', '/auth/staff/login', undefined, {
    username,
    password: STAFF_PASSWORD,
    client: 'mobile',
  });
  const pending = String(login['accessToken']);
  const enroll = await call('POST', '/auth/totp/enroll', pending);
  const totpSecret = String(enroll['secret']);
  const { step, code } = freshCode(totpSecret, 0);
  const done = await call('POST', '/auth/totp/verify', pending, { code });
  return {
    username,
    accountId,
    totpSecret,
    lastStep: step,
    token: String(done['accessToken']),
  } satisfies Staff;
}

/**
 * Task 4-6: a center account is linked or granted only with a mobile it proved by a code.
 * This throwaway database records it directly for the seeded center accounts.
 */
export async function proveMobile(ownerUrl: string, accountId: string) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  await client.query(
    'UPDATE user_accounts SET mobile = $1, mobile_verified_at = now() WHERE id = $2',
    [`913${digits(7)}`, accountId],
  );
  await client.end();
}

export async function seed(options: {
  env: NodeJS.ProcessEnv;
  ownerUrl: string;
}): Promise<Fixture> {
  const { env } = options;
  stepUpOwnerUrl = options.ownerUrl;
  // ADR-052 (owner 1405/08/03): 0106 ships the SMS code off; this throwaway stack runs it on,
  // as after launch, so every financial path here signs with its code.
  {
    const client = new pg.Client({ connectionString: options.ownerUrl });
    await client.connect();
    await client.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('identity.financial_step_up', 'global',
               '{"enabled": true, "codeTtlSeconds": 120, "maxAttempts": 5, "lockoutSeconds": 900,
                 "resendAfterSeconds": 60, "maxSendsPerHour": 3, "mobileChangeDelayHours": 24}',
               now() - interval '1 second', 'approved', 'e2e', now())`,
    );
    await client.end();
  }
  // The first administrator, as on a real install, then everyone else through the API.
  const admin = await account(env, 'staff', 'admin');
  cli('dist/modules/access/cli/grant-role.js', {
    ...env,
    ACCOUNT_ID: admin.accountId,
    ROLE_CODE: 'system_admin',
    GRANT_REASON: reason.reason,
  });
  // Owner 1405/08/02 (0105): holidays are the CEO's; the administrator who saves them in the
  // tests holds the CEO's role too.
  cli('dist/modules/access/cli/grant-role.js', {
    ...env,
    ACCOUNT_ID: admin.accountId,
    ROLE_CODE: 'ceo',
    GRANT_REASON: reason.reason,
  });
  const [specialist, networkManager, approver, manager] = await Promise.all([
    account(env, 'staff', 'specialist'),
    account(env, 'staff', 'network'),
    account(env, 'staff', 'approver'),
    account(env, 'center', 'manager'),
  ]);
  const grant = (who: Staff, roleCode: string, scope: Body) =>
    call('POST', '/access/assignments', admin.token, {
      accountId: who.accountId,
      roleCode,
      scope,
      ...reason,
    });
  // The pilot city (owner decision, task 2-11): the network works in Isfahan only.
  await proveMobile(options.ownerUrl, manager.accountId);
  await grant(specialist, 'network_specialist', { kind: 'city', code: 'isfahan' });
  await grant(networkManager, 'network_manager', { kind: 'global' });
  // Owner 1405/07/27: holidays are saved by two holders of config.manage_holidays (the CEO's
  // role since 0105).
  const admin2 = await account(env, 'staff', 'admin2');
  await grant(admin2, 'system_admin', { kind: 'global' });
  await grant(admin2, 'ceo', { kind: 'global' });
  await grant(approver, 'network_manager', { kind: 'global' });

  // The search is behind its flag (task 2-7); on in this database only.
  const db = new pg.Client({ connectionString: options.ownerUrl });
  await db.connect();
  await db.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('catalog.search_enabled', 'global', 'true'::jsonb, now(), 'approved', $1, now())`,
    [reason.reason],
  );
  // Every browser of the suite signs in from 127.0.0.1; with the completion path (task
  // 4-4) the suite sends more than the 20 codes an hour one address may ask for. Raised in
  // this throwaway database only; every other OTP limit stays as migration 0003 set it.
  await db.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('identity.otp', 'global', $1::jsonb, now(), 'approved', $2, now())`,
    [
      JSON.stringify({
        ttlSeconds: 180,
        resendCooldownSeconds: 60,
        sendsPerMobilePerHour: 8,
        sendsPerIpPerHour: 200,
        sendsPerDevicePerHour: 10,
        failuresBeforeLock: 6,
        failuresPerIpPerHour: 30,
      }),
      reason.reason,
    ],
  );
  await db.end();

  await call('POST', '/catalog/fields', networkManager.token, {
    code: 'dental',
    name: 'دندانپزشکی',
    ...reason,
  });

  // An active center: documents received and checked, then two people activate it.
  const centerName = 'کلینیک دندانپزشکی آفتاب';
  const center = await call('POST', '/catalog/centers', specialist.token, {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: centerName,
    cityCode: 'isfahan',
    sheba: sheba(),
    accountHolderName: 'مریم آفتاب',
    treatmentFieldCodes: ['dental'],
  });
  const centerId = String(center['id']);
  const documents = async (status: string) => {
    const detail = await call('GET', `/catalog/centers/${centerId}`, specialist.token);
    for (const doc of detail['documents'] as { code: string }[]) {
      await call('PUT', `/catalog/centers/${centerId}/documents/${doc.code}`, specialist.token, {
        status,
      });
    }
  };
  await documents('received');
  await call('POST', `/catalog/centers/${centerId}/submit`, specialist.token, reason);
  await documents('verified');
  const activation = await call(
    'POST',
    `/catalog/centers/${centerId}/activation-requests`,
    specialist.token,
    reason,
  );
  await call('POST', `/catalog/requests/${String(activation['id'])}/approve`, approver.token, {});
  const detail = await call('GET', `/catalog/centers/${centerId}`, specialist.token);
  const branch = (detail['branches'] as { id: string }[])[0]?.id;
  await grant(manager, 'center_manager', { kind: 'center', nodeId: String(center['nodeId']) });

  // The doctor, the visit's price and the weekly hours (Saturday to Wednesday, 09–13).
  const doctorName = 'دکتر نگار زرین‌مکان';
  const doctor = await call('POST', '/catalog/doctors', specialist.token, {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: doctorName,
    medicalCouncilNumber: String(randomInt(10_000_000, 99_999_999)),
    treatmentFieldCodes: ['dental'],
    workplace: { kind: 'branch', branchId: branch },
    ...reason,
  });
  const doctorId = String(doctor['id']);
  const doctorDetail = await call('GET', `/catalog/doctors/${doctorId}`, specialist.token);
  const workplaceId = (doctorDetail['workplaces'] as { id: string }[])[0]?.id ?? '';
  await call('POST', '/catalog/tariffs', manager.token, {
    owner: { kind: 'workplace', workplaceId },
    serviceCode: 'visit',
    pricing: { kind: 'range', minRial: '5000000', maxRial: '8000000' },
    ...reason,
  });
  await call('PUT', `/booking/workplaces/${workplaceId}/schedule`, manager.token, {
    ranges: ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday'].map((weekday) => ({
      weekday,
      start: '09:00',
      end: '13:00',
      slotMinutes: 30,
      serviceCodes: ['visit'],
    })),
    ...reason,
  });

  // The public profile: drafted by the center, approved by the network specialist.
  const profileSlug = `dr-negar-zarrinmakan-${randomBytes(2).toString('hex')}`;
  await call('POST', `/catalog/doctors/${doctorId}/profile`, specialist.token, {
    slug: profileSlug,
    ...reason,
  });
  await call('PUT', `/catalog/doctors/${doctorId}/profile/draft`, manager.token, {
    specialtyTitle: 'متخصص ارتودنسی',
    biography: 'بیش از ده سال تجربه در درمان ارتودنسی کودکان و بزرگسالان.',
    history: ['دکترای دندانپزشکی، دانشگاه علوم پزشکی اصفهان', 'تخصص ارتودنسی'],
    ...reason,
  });
  const submitted = await call(
    'POST',
    `/catalog/doctors/${doctorId}/profile/submit`,
    manager.token,
    reason,
  );
  await call(
    'POST',
    `/catalog/profile-versions/${String(submitted['id'])}/approve`,
    specialist.token,
    reason,
  );

  // Phase 3 (task 3-8): the doctor signs in to issue proformas; the credit units; and one
  // approved credit plan for dental care in Isfahan, proposed and approved by two people.
  const [doctorAccount, completion, creditSpecialist, creditManager, strategyA, strategyB] =
    await Promise.all([
      account(env, 'center', 'doctor'),
      account(env, 'staff', 'completion'),
      account(env, 'staff', 'credit'),
      account(env, 'staff', 'creditmanager'),
      account(env, 'staff', 'strategy_a'),
      account(env, 'staff', 'strategy_b'),
    ]);
  await proveMobile(options.ownerUrl, doctorAccount.accountId);
  await call('POST', `/catalog/doctors/${doctorId}/account`, specialist.token, {
    accountId: doctorAccount.accountId,
    ...reason,
  });
  await grant(completion, 'case_completion', { kind: 'global' });
  await grant(creditSpecialist, 'credit_specialist', { kind: 'global' });
  await grant(creditManager, 'credit_manager', { kind: 'global' });
  await grant(strategyA, 'strategy_manager', { kind: 'global' });
  await grant(strategyB, 'strategy_manager', { kind: 'global' });
  // Phase 4 (task 4-4): finance decides the completion receipts.
  const finance = await account(env, 'staff', 'finance');
  await grant(finance, 'accounting', { kind: 'global' });
  // Task 4-7: asks for funding and may approve, but never their own request.
  const completionFinance = await account(env, 'staff', 'completionfinance');
  await grant(completionFinance, 'case_completion', { kind: 'global' });
  await grant(completionFinance, 'accounting', { kind: 'global' });
  const plan = await call('POST', '/config/proposals', strategyA.token, {
    key: 'credit.plans',
    scope: { level: 'global' },
    value: {
      plans: [
        {
          code: 'dental_isfahan',
          title: 'طرح درمان دندان اصفهان',
          active: true,
          cityCode: 'isfahan',
          treatmentFieldCodes: ['dental'],
          doctorIds: null,
          minAmountRial: '1000000',
          maxAmountRial: '500000000',
          downPayment: { basis: 'percent', bps: 2000 },
          installmentCounts: [6, 12],
          planFee: { basis: 'percent', bps: 1000, timing: 'spread' },
          originationFee: { basis: 'fixed', rial: '500000' },
          // ADR-035: a plan added from now on rounds its shares to whole tomans.
          percentRoundingRial: '10',
        },
      ],
    },
    reason: 'طرح آزمون انتهابه‌انتها',
  });
  await call('POST', `/config/proposals/${String(plan['id'])}/approve`, strategyB.token);

  // For the internal panel: a second doctor whose profile waits for review…
  const reviewDoctorName = 'دکتر سارا امینی';
  const reviewDoctor = await call('POST', '/catalog/doctors', specialist.token, {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: reviewDoctorName,
    medicalCouncilNumber: String(randomInt(10_000_000, 99_999_999)),
    treatmentFieldCodes: ['dental'],
    workplace: { kind: 'branch', branchId: branch },
    ...reason,
  });
  const reviewDoctorId = String(reviewDoctor['id']);
  const reviewSlug = `dr-sara-amini-${randomBytes(2).toString('hex')}`;
  await call('POST', `/catalog/doctors/${reviewDoctorId}/profile`, specialist.token, {
    slug: reviewSlug,
    ...reason,
  });
  await call('PUT', `/catalog/doctors/${reviewDoctorId}/profile/draft`, manager.token, {
    specialtyTitle: 'متخصص دندانپزشکی کودکان',
    biography: 'درمان دندان کودکان با رویکرد بی‌درد.',
    history: ['دکترای دندانپزشکی، دانشگاه علوم پزشکی اصفهان'],
    ...reason,
  });
  await call('POST', `/catalog/doctors/${reviewDoctorId}/profile/submit`, manager.token, reason);

  // …and a center submitted for review, its documents received, none checked yet.
  const reviewCenterName = 'مرکز درمانی نقش جهان';
  const reviewCenter = await call('POST', '/catalog/centers', specialist.token, {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: reviewCenterName,
    cityCode: 'isfahan',
    sheba: sheba(),
    accountHolderName: 'علی نقش‌جهان',
    treatmentFieldCodes: ['dental'],
  });
  const reviewCenterId = String(reviewCenter['id']);
  const reviewDetail = await call('GET', `/catalog/centers/${reviewCenterId}`, specialist.token);
  for (const doc of reviewDetail['documents'] as { code: string }[]) {
    await call(
      'PUT',
      `/catalog/centers/${reviewCenterId}/documents/${doc.code}`,
      specialist.token,
      {
        status: 'received',
      },
    );
  }
  await call('POST', `/catalog/centers/${reviewCenterId}/submit`, specialist.token, reason);

  // The bulk import is behind its flag (task 2-9): on in this database, for its page.
  const flags = new pg.Client({ connectionString: options.ownerUrl });
  await flags.connect();
  await flags.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('catalog.bulk_import_enabled', 'global', 'true'::jsonb, now(), 'approved', $1, now())`,
    [reason.reason],
  );
  await flags.end();

  // The worker builds the search entry from the outbox; wait until it is there.
  for (let i = 0; i < 120; i++) {
    const found = await fetch(
      `${STACK.apiUrl}/api/v1/search/doctors?centerName=${encodeURIComponent('آفتاب')}`,
    );
    if (found.ok && ((await found.json()) as { total: number }).total > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Task 4-8: a funded purse of its own, wholly unused, for the special-operations test.
  const funded = await fundedPurse(
    call,
    {
      doctor: doctorAccount.token,
      center: manager.token,
      completion: completion.token,
      creditSpecialist: creditSpecialist.token,
      creditManager: creditManager.token,
      finance: finance.token,
      completionFinance: completionFinance.token,
    },
    workplaceId,
  );
  // Task 5-6: another, for the settlement panel test (a service on it, then a dispute).
  const settlementFunded = await fundedPurse(
    call,
    {
      doctor: doctorAccount.token,
      center: manager.token,
      completion: completion.token,
      creditSpecialist: creditSpecialist.token,
      creditManager: creditManager.token,
      finance: finance.token,
      completionFinance: completionFinance.token,
    },
    workplaceId,
  );

  // Task 7-7: another, for the financial complaint path (a service on it, then a complaint).
  const complaintFunded = await fundedPurse(
    call,
    {
      doctor: doctorAccount.token,
      center: manager.token,
      completion: completion.token,
      creditSpecialist: creditSpecialist.token,
      creditManager: creditManager.token,
      finance: finance.token,
      completionFinance: completionFinance.token,
    },
    workplaceId,
  );

  // Task 6-9: a loan for the slip path, and one with a guarantor for the collection path;
  // the collection unit (agent, manager) and the queue's share to the agent.
  const people = {
    doctor: doctorAccount.token,
    center: manager.token,
    completion: completion.token,
    creditSpecialist: creditSpecialist.token,
    creditManager: creditManager.token,
    finance: finance.token,
    completionFinance: completionFinance.token,
  };
  const repaymentFunded = await fundedPurse(call, people, workplaceId);
  const collectionFunded = await fundedPurse(call, people, workplaceId, { guarantor: true });
  const collectionAgent = await account(env, 'staff', 'collection');
  await grant(collectionAgent, 'collection', { kind: 'global' });
  const collectionManager = await account(env, 'staff', 'collectionmanager');
  await grant(collectionManager, 'collection_manager', { kind: 'global' });
  const support = await account(env, 'staff', 'support');
  await grant(support, 'support', { kind: 'global' });
  await call('PUT', '/lead/assignment/shares', strategyA.token, {
    queueCode: 'collection',
    shares: [{ accountId: collectionAgent.accountId, percent: 100 }],
    ...reason,
  });
  // Task 7-5: the CEO's dashboard, and support taking its ticket queue (7-1).
  const ceo = await account(env, 'staff', 'ceo');
  await grant(ceo, 'ceo', { kind: 'global' });
  // ADR-048: the customer club's officer.
  const clubOfficer = await account(env, 'staff', 'clubofficer');
  await grant(clubOfficer, 'club_officer', { kind: 'global' });
  await call('PUT', '/lead/assignment/shares', strategyA.token, {
    queueCode: 'ticket_support',
    shares: [{ accountId: support.accountId, percent: 100 }],
    ...reason,
  });
  // One ticket of a borrower's, taken by support: the unit's dashboard is not empty.
  await call('POST', '/me/tickets', repaymentFunded.patientToken, {
    topicCode: 'general',
    subject: 'پرسش درباره قسط',
    body: 'سررسید قسط بعدی کی است؟',
    links: [],
  });

  // The owner's visual approval (1405/07/23): a Person whose owner has two mobiles waiting
  // for them (added by an advisor with the same national ID), three holders of a role with
  // lead.approve_person_mobile for the two-person decision, and a credit application left as
  // a draft (its locked quote).
  const advisor = await account(env, 'staff', 'advisor');
  await grant(advisor, 'advisor', { kind: 'own' });
  // Owner 1405/07/24 (م۹): the advisor takes every advisory lead from here on, for its pages.
  await call('PUT', '/lead/assignment/shares', strategyA.token, {
    queueCode: 'advisory',
    shares: [{ accountId: advisor.accountId, percent: 100 }],
    ...reason,
  });
  const ownerMobile = `915${digits(7)}`;
  const personNationalId = nationalId();
  const intake = (mobile: string) =>
    call('POST', '/lead/intakes', advisor.token, {
      mobile: `0${mobile}`,
      name: 'بیمار نمونه',
      nationalId: personNationalId,
      treatmentFieldCode: 'dental',
    });
  await intake(ownerMobile);
  await call('POST', '/auth/otp/request', undefined, { mobile: `0${ownerMobile}` });
  await call('POST', '/auth/otp/verify', undefined, {
    mobile: `0${ownerMobile}`,
    code: await codeFor(ownerMobile),
    client: 'mobile',
  });
  const pendingMobiles = [`915${digits(7)}`, `915${digits(7)}`];
  for (const mobile of pendingMobiles) await intake(mobile);
  await call('POST', '/access/roles', admin.token, {
    code: 'mobile_approver',
    name: 'تأیید شماره بیمار',
    permissions: ['lead.approve_person_mobile'],
    ...reason,
  });
  const mobileApprovers = [
    await account(env, 'staff', 'mobileapproverone'),
    await account(env, 'staff', 'mobileapprovertwo'),
    await account(env, 'staff', 'mobileapproverthree'),
  ];
  for (const who of mobileApprovers) await grant(who, 'mobile_approver', { kind: 'global' });
  // ف۱۲ ب۲ (owner 1405/07/26): two holders of identity.change_patient_mobile, and the flag
  // identity.patient_mobile_change on, in this throwaway database only (off everywhere else).
  await call('POST', '/access/roles', admin.token, {
    code: 'patient_mobile_changer',
    name: 'تغییر شماره بیمار',
    permissions: ['identity.change_patient_mobile'],
    ...reason,
  });
  const mobileChangers = [
    await account(env, 'staff', 'mobilechangerone'),
    await account(env, 'staff', 'mobilechangertwo'),
  ];
  for (const who of mobileChangers) {
    await grant(who, 'patient_mobile_changer', { kind: 'global' });
  }
  const changeFlag = new pg.Client({ connectionString: options.ownerUrl });
  await changeFlag.connect();
  await changeFlag.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('identity.patient_mobile_change', 'global', $1::jsonb, now(), 'approved', $2, now())`,
    [JSON.stringify({ enabled: true, recentLoginSeconds: 600, cooldownDays: 0 }), reason.reason],
  );
  await changeFlag.end();
  const draft = await fundedPurse(call, people, workplaceId, { draftOnly: true });

  // Owner 1405/07/24: a loan whose due days moved at funding, for «moved from … because of a
  // holiday» in the borrower's own schedule. The shift on while its case is made (it is locked
  // there, ADR-041), national holidays on its 2nd and 3rd nominal due days (not the 30 days
  // the holiday test uses), then the shift off again; in this throwaway database only.
  const shiftFlag = new pg.Client({ connectionString: options.ownerUrl });
  await shiftFlag.connect();
  const shiftTo = (on: boolean) =>
    shiftFlag.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('repayment.shift_due_to_next_working_day', 'global', $1::jsonb, now(), 'approved', $2, now())`,
      [JSON.stringify(on), reason.reason],
    );
  const today = toJalali(new Date());
  const movedNominal = [2, 3].map((k) => addJalaliMonths(today, k));
  // Owner 1405/07/27: no single-day path; the seed writes its two test days directly, as it
  // writes its configuration above (a batch would need a second holder of the permission).
  for (const on of movedNominal) {
    await shiftFlag.query(
      `INSERT INTO holidays (holiday_on, title, kind) VALUES ($1::date, $2, 'national')
       ON CONFLICT DO NOTHING`,
      [gregorianDayOf(on), 'تعطیلی آزمون جابه‌جایی'],
    );
  }
  await shiftTo(true);
  const movedFunded = await fundedPurse(call, people, workplaceId);
  await shiftTo(false);
  await shiftFlag.end();

  // ADR-052: a financial signature asks for an SMS code on the signer's own verified mobile, one
  // mobile per person. Every staff account here gets its own (the last four digits differ, so
  // the masked numbers the dialog shows do too), except support: the required-mobile screenshot
  // signs it in without one.
  {
    const client = new pg.Client({ connectionString: options.ownerUrl });
    await client.connect();
    await client.query(
      `UPDATE user_accounts u
          SET mobile = '9170' || lpad((n.i + 5000)::text, 6, '0'), mobile_verified_at = now()
         FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS i
                 FROM user_accounts
                WHERE kind = 'staff' AND mobile_verified_at IS NULL AND id <> $1) n
        WHERE u.id = n.id`,
      [support.accountId],
    );
    await client.end();
  }

  const plain = (staff: Staff): SeededStaff => ({
    username: staff.username,
    accountId: staff.accountId,
    totpSecret: staff.totpSecret,
    lastStep: staff.lastStep,
  });
  return {
    centerId,
    centerName,
    doctorName,
    workplaceId,
    profileSlug,
    manager: plain(manager),
    specialist: plain(specialist),
    admin: plain(admin),
    admin2: plain(admin2),
    approver: plain(approver),
    networkManager: plain(networkManager),
    doctor: plain(doctorAccount),
    completion: plain(completion),
    creditSpecialist: plain(creditSpecialist),
    creditManager: plain(creditManager),
    finance: plain(finance),
    completionFinance: plain(completionFinance),
    reviewCenterId,
    reviewCenterName,
    reviewDoctorId,
    reviewDoctorName,
    reviewSlug,
    fundedApplicationId: funded.applicationId,
    settlementPurseId: settlementFunded.purseId,
    settlementPatientMobile: settlementFunded.mobile,
    complaintPurseId: complaintFunded.purseId,
    complaintPatientMobile: complaintFunded.mobile,
    strategyA: plain(strategyA),
    strategyB: plain(strategyB),
    repaymentApplicationId: repaymentFunded.applicationId,
    repaymentPatientMobile: repaymentFunded.mobile,
    collectionApplicationId: collectionFunded.applicationId,
    collectionPatientMobile: collectionFunded.mobile,
    collectionGuarantorMobile: collectionFunded.guarantorMobile ?? '',
    collectionAgent: plain(collectionAgent),
    collectionManager: plain(collectionManager),
    support: plain(support),
    advisor: plain(advisor),
    ceo: plain(ceo),
    clubOfficer: plain(clubOfficer),
    pendingOwnerMobile: ownerMobile,
    pendingMobiles,
    mobileApprovers: mobileApprovers.map(plain),
    mobileChangers: mobileChangers.map(plain),
    draftApplicationId: draft.applicationId,
    draftPatientMobile: draft.mobile,
    movedPatientMobile: movedFunded.mobile,
    movedNominalDays: movedNominal,
  };
}
