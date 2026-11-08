import 'reflect-metadata';
import { randomBytes, randomInt } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { StartedRedisContainer } from '@testcontainers/redis';
import {
  normalizeMobile,
  PERSON_DIRECTORY,
  type PersonDirectory,
  type ScopeInput,
  type SendOtpJob,
  type SendStepUpJob,
  stepUpOperationSchema,
} from '@sepehr/contracts';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import type { EffectiveAccess } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { RequirePermission } from '../../src/common/auth/auth.decorators';
import type { Actor } from '../../src/common/audit/audit.port';
import {
  MALWARE_SCANNER,
  type MalwareScanner,
  type ScanResult,
} from '../../src/common/security/malware-scanner.port';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
  type StorageSpace,
} from '../../src/common/storage/object-storage.port';
import { configureApp } from '../../src/configure-app';
import { createPool } from '../../src/db/pool';
import { AccessService } from '../../src/modules/access/access.service';
import { OTP_SENDER } from '../../src/modules/identity/otp-login.service';
import { STEP_UP_SENDER } from '../../src/infra/sms-queue';
import { IDENTITY_SECRETS, type IdentitySecrets } from '../../src/modules/identity/identity.tokens';
import { operationKey } from '../../src/modules/identity/step-up.service';
import { keyedHash } from '../../src/modules/identity/tokens';
import { StaffAuthService } from '../../src/modules/identity/staff-auth.service';
import { base32Decode, hotp, totpStep } from '../../src/modules/identity/totp';
import { startMigratedDatabase, type MigratedDatabase } from '../support/postgres';
import { startRedis } from '../support/redis';

export const WEB_ORIGIN = 'https://app.sepehr.test';

/** Captures OTP jobs instead of queueing them. */
export class CapturingOtpSender {
  readonly sent: SendOtpJob[] = [];
  /** Makes the next send fail, as if the queue were down. */
  failNext = false;
  sendOtp(job: SendOtpJob): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('queue unavailable'));
    }
    this.sent.push(job);
    return Promise.resolve();
  }
  lastCodeFor(mobile: string): string {
    const job = [...this.sent].reverse().find((j) => j.mobile === mobile);
    if (!job) throw new Error(`no code sent to ${mobile}`);
    return job.code;
  }
}

/** ADR-052: captures financial approval codes instead of queueing them. */
export class CapturingStepUpSender {
  readonly sent: SendStepUpJob[] = [];
  /** Makes the next send fail, as if SMS were down. */
  failNext = false;
  sendStepUp(job: SendStepUpJob): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('queue unavailable'));
    }
    this.sent.push(job);
    return Promise.resolve();
  }
  lastCodeFor(mobile: string): string {
    const job = [...this.sent].reverse().find((j) => j.mobile === mobile);
    if (!job) throw new Error(`no step-up code sent to ${mobile}`);
    return job.code;
  }
}

/**
 * Stand-in for the lead module's PERSON_DIRECTORY, for tests that need it to fail on
 * demand (`startHarness({ fakePersons: true })`); every other test uses the real one.
 */
export class FakePersonDirectory implements PersonDirectory {
  readonly persons = new Map<string, string>();
  calls = 0;
  failNext = false;
  findOrCreateByMobile(mobile: string) {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('person directory unavailable'));
    }
    let personId = this.persons.get(mobile);
    if (!personId) {
      personId = crypto.randomUUID();
      this.persons.set(mobile, personId);
    }
    return Promise.resolve({ personId });
  }
  linkLogin(mobile: string) {
    return this.findOrCreateByMobile(mobile);
  }
  mobilesByIds() {
    return Promise.resolve([]);
  }
  standsFor(mobile: string, personId: string) {
    return Promise.resolve(this.persons.get(mobile) === personId);
  }
}

/**
 * Test-only endpoints. `/probe` needs a permission few hold (default deny);
 * `/probe/sensitive` returns every kind of sensitive field, nested, to check the output
 * filter of doc 04 §4.
 */
@Controller('probe')
class ProbeController {
  @RequirePermission('audit.read')
  @Get()
  get() {
    return { reached: true };
  }

  @RequirePermission('access.read_org')
  @Get('sensitive')
  sensitive() {
    return {
      caseId: 'c1',
      amountRial: '120000000',
      treatmentDescription: 'implant, 4 units',
      treatmentField: 'dental',
      doctorName: 'Dr A',
      creditScore: 712,
      rejectionReasons: ['income'],
      patientIncome: '900000000',
      installments: [{ dueAt: '2026-10-01', amountRial: '10000000', doctorName: 'Dr A' }],
      history: { last: { treatmentDescription: 'crown', note: 'kept' } },
    };
  }
}

export interface Harness {
  app: INestApplication;
  baseUrl: string;
  sms: CapturingOtpSender;
  /** ADR-052: the financial approval codes sent. */
  stepUps: CapturingStepUpSender;
  /** The stand-in; used by the app only with `fakePersons`. */
  persons: FakePersonDirectory;
  redis: Redis;
  /** Owner connection, for checks and fixtures. */
  owner: Pool;
  db: MigratedDatabase;
  redisContainer: StartedRedisContainer;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Replace the lead module's PERSON_DIRECTORY with {@link FakePersonDirectory}. */
  readonly fakePersons?: boolean;
  /**
   * Replace object storage and the malware scanner with {@link MemoryStorage} and
   * {@link FakeScanner} (task 3-5): for tests that only need files to pass through. The
   * real SeaweedFS and clamd are tested where files are the subject (support/files).
   */
  readonly fakeFiles?: boolean;
  /** Further providers to replace, as [token, value] (task 4-6: the service-code SMS). */
  readonly overrides?: readonly (readonly [token: string | symbol, value: unknown])[];
  /** ADR-052: leave the SMS code off, as migration 0106 ships it (on by default here). */
  readonly stepUpOff?: boolean;
}

/** Captures text SMS instead of queueing them (task 4-6: service codes). */
export class CapturingTextSender {
  readonly sent: { mobile: string; text: string; jobId: string }[] = [];
  sendText(job: { mobile: string; text: string }, jobId: string): Promise<void> {
    this.sent.push({ mobile: job.mobile, text: job.text, jobId });
    return Promise.resolve();
  }
}

/** Object storage in memory; signed links are fake but name the key. */
export class MemoryStorage implements ObjectStorage {
  readonly configured = true;
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  put(space: StorageSpace, key: string, body: Buffer, contentType: string) {
    this.objects.set(`${space}/${key}`, { body, contentType });
    return Promise.resolve();
  }
  get(space: StorageSpace, key: string) {
    const found = this.objects.get(`${space}/${key}`);
    return found ? Promise.resolve(found.body) : Promise.reject(new Error('no such object'));
  }
  copy(from: StorageSpace, key: string, to: StorageSpace, toKey = key) {
    const found = this.objects.get(`${from}/${key}`);
    if (found) this.objects.set(`${to}/${toKey}`, found);
    return Promise.resolve();
  }
  remove(space: StorageSpace, key: string) {
    this.objects.delete(`${space}/${key}`);
    return Promise.resolve();
  }
  signedUrl(key: string, seconds: number) {
    return Promise.resolve(`memory://private/${key}?expires=${String(seconds)}`);
  }
  publicUrl(key: string) {
    return `memory://public/${key}`;
  }
}

/** Flags the EICAR test string as clamd does; everything else is clean. */
export class FakeScanner implements MalwareScanner {
  readonly configured = true;
  scan(file: Buffer): Promise<ScanResult> {
    return Promise.resolve(
      file.toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
        ? { clean: false, signature: 'Eicar-Test-Signature' }
        : { clean: true },
    );
  }
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const [db, redisContainer] = await Promise.all([startMigratedDatabase(), startRedis()]);
  Object.assign(process.env, {
    DATABASE_URL: db.appUrl,
    // Reports read through the read-only role (no replica in tests, ADR-020).
    REPORTING_DATABASE_URL: db.reportUrl,
    REDIS_URL: redisContainer.getConnectionUrl(),
    AUTH_SECRET: randomBytes(32).toString('base64'),
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
    WEB_ORIGINS: WEB_ORIGIN,
    // Lets tests pick the client IP with X-Forwarded-For.
    TRUST_PROXY: 'loopback',
  });

  // R10 (task 9-3): migration 0076 closes the internal panel to every network. Off in this
  // throwaway database (not production), as the tests pick client IPs at random; the access
  // tests switch it on, and test the closed default itself.
  const seedOwner = createPool(db.ownerUrl, 'test-owner-seed');
  await seedOwner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('access.internal_panel_ip_allowlist', 'global', '{"enabled": false, "cidrs": []}',
             $1, 'approved', 'test fixture', $1)`,
    // The API's clock: the container's may run a moment ahead.
    [new Date()],
  );
  // ADR-052 (owner 1405/08/03): the SMS code ships off; the tests run it on, as after launch,
  // so every financial path is exercised with its code. `stepUpOff` keeps the shipped default.
  if (!options.stepUpOff) {
    await seedOwner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('identity.financial_step_up', 'global',
               '{"enabled": true, "codeTtlSeconds": 120, "maxAttempts": 5, "lockoutSeconds": 900,
                 "resendAfterSeconds": 60, "maxSendsPerHour": 3, "mobileChangeDelayHours": 24}',
               $1, 'approved', 'test fixture', $1)`,
      [new Date()],
    );
  }
  await seedOwner.end();

  const sms = new CapturingOtpSender();
  const stepUps = new CapturingStepUpSender();
  const persons = new FakePersonDirectory();

  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProbeController],
  })
    .overrideProvider(OTP_SENDER)
    .useValue(sms)
    .overrideProvider(STEP_UP_SENDER)
    .useValue(stepUps);
  if (options.fakePersons) builder = builder.overrideProvider(PERSON_DIRECTORY).useValue(persons);
  if (options.fakeFiles) {
    builder = builder
      .overrideProvider(OBJECT_STORAGE)
      .useValue(new MemoryStorage())
      .overrideProvider(MALWARE_SCANNER)
      .useValue(new FakeScanner());
  }
  for (const [token, value] of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  // As in main.ts: the lead webhook checks its signature over the raw body.
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;

  const redis = new Redis(redisContainer.getConnectionUrl());
  const owner = createPool(db.ownerUrl, 'test-owner');
  return {
    app,
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1`,
    sms,
    stepUps,
    persons,
    redis,
    owner,
    db,
    redisContainer,
    async close() {
      await app.close();
      redis.disconnect();
      await owner.end();
      // Removed with their volumes, said outright (owner 1405/07/23); Ryuk is the backstop.
      await Promise.all([
        db.container.stop({ removeVolumes: true }),
        redisContainer.stop({ removeVolumes: true }),
      ]);
    },
  };
}

/** A mobile never used before in this run. */
export const newMobile = () => `912${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
/** A client IP never used before, so rate limits of one test do not leak into another. */
export const newIp = () =>
  `10.${String(randomInt(0, 256))}.${String(randomInt(0, 256))}.${String(randomInt(1, 255))}`;

export interface CallOptions {
  body?: unknown;
  bearer?: string;
  cookie?: string;
  csrf?: string;
  origin?: string;
  ip?: string;
  deviceId?: string;
  /** Any other request headers (an Idempotency-Key, task 2-6). */
  headers?: Record<string, string>;
  /**
   * ADR-052: by default a request answered `step_up_required` is signed the real way (a code to
   * the caller's own verified mobile, read from the captured SMS) and sent again. `false`
   * leaves the refusal as it is, for the tests of the step-up itself.
   */
  stepUp?: false;
}

export interface CallResult {
  status: number;
  body: Record<string, unknown>;
  /** Set-Cookie headers, by cookie name. */
  cookies: Map<string, string>;
}

export async function call(
  h: Harness,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<CallResult> {
  const first = await rawCall(h, method, path, options);
  if (
    options.stepUp === false ||
    first.status !== 403 ||
    first.body['error'] !== 'step_up_required' ||
    (!options.bearer && !options.cookie)
  ) {
    return first;
  }
  const proof = await stepUpProof(h, options, first.body['operation']);
  return rawCall(h, method, path, {
    ...options,
    headers: { ...options.headers, 'x-step-up': proof },
  });
}

/**
 * ADR-052: a real code for the operation a refusal named. The caller's account gets a verified
 * mobile of its own if it has none (as a staff member would before signing anything), and the
 * minute between codes and the hour's three are cleared: the tests sign many things in seconds.
 */
async function stepUpProof(h: Harness, options: CallOptions, asked: unknown): Promise<string> {
  const operation = stepUpOperationSchema.parse(asked);
  const auth: CallOptions = {
    ...(options.bearer ? { bearer: options.bearer } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.csrf ? { csrf: options.csrf } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  const me = await rawCall(h, 'GET', '/auth/me', auth);
  const accountId = me.body['accountId'] as string | undefined;
  if (!accountId) throw new Error(`step-up: no account behind the request (${String(me.status)})`);
  await h.owner.query(
    `UPDATE user_accounts
        SET mobile = COALESCE(mobile, '912' || lpad((floor(random() * 1e7))::int::text, 7, '0')),
            mobile_verified_at = COALESCE(mobile_verified_at, now())
      WHERE id = $1`,
    [accountId],
  );
  const key = operationKey({
    type: operation.type,
    id: operation.id,
    amountRial: operation.amountRial === null ? null : BigInt(operation.amountRial),
    step: operation.step,
  });
  await h.redis.del(
    `identity:step-up-cooldown:${accountId}:${key}`,
    `identity:step-up-send:${accountId}:${key}`,
  );
  const sent = await rawCall(h, 'POST', '/identity/step-up/challenges', {
    ...auth,
    body: operation,
  });
  if (sent.status !== 201) {
    throw new Error(
      `step-up challenge refused: ${String(sent.status)} ${JSON.stringify(sent.body)}`,
    );
  }
  const { rows } = await h.owner.query<{ mobile: string }>(
    'SELECT mobile FROM user_accounts WHERE id = $1',
    [accountId],
  );
  const challengeId = sent.body['challengeId'] as string;
  // Of the codes sent to this mobile, the one this challenge holds: two signatures of one
  // person at once each get their own (the newest may be the other's).
  const raw = await h.redis.get(`identity:step-up:${challengeId}`);
  const stored = raw ? (JSON.parse(raw) as { codeHash: string }) : null;
  const { authSecret } = h.app.get<IdentitySecrets>(IDENTITY_SECRETS);
  const code = [...h.stepUps.sent]
    .reverse()
    .filter((j) => j.mobile === rows[0]?.mobile)
    .map((j) => j.code)
    .find(
      (c) =>
        keyedHash(authSecret, 'step-up', `${challengeId}:${accountId}:${key}:${c}`) ===
        stored?.codeHash,
    );
  if (!code) throw new Error(`step-up: no code found for challenge ${challengeId}`);
  return `${challengeId}.${code}`;
}

async function rawCall(
  h: Harness,
  method: string,
  path: string,
  options: CallOptions,
): Promise<CallResult> {
  const headers: Record<string, string> = { 'x-forwarded-for': options.ip ?? newIp() };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.bearer) headers['authorization'] = `Bearer ${options.bearer}`;
  if (options.cookie) headers['cookie'] = `__Host-sid=${options.cookie}`;
  if (options.csrf) headers['x-csrf-token'] = options.csrf;
  if (options.origin) headers['origin'] = options.origin;
  if (options.deviceId) headers['x-device-id'] = options.deviceId;
  Object.assign(headers, options.headers);

  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  const cookies = new Map<string, string>();
  for (const header of res.headers.getSetCookie()) {
    const name = header.slice(0, header.indexOf('='));
    cookies.set(name, header);
  }
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    cookies,
  };
}

/** Value of a cookie from its Set-Cookie header. */
export const cookieValue = (setCookie: string | undefined) =>
  setCookie?.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';')) ?? '';

/** Full OTP login; returns the response of the verify call. */
export async function otpLogin(
  h: Harness,
  mobile: string,
  client: 'web' | 'mobile',
  options: CallOptions = {},
) {
  const requested = await call(h, 'POST', '/auth/otp/request', { ...options, body: { mobile } });
  if (requested.status !== 202) throw new Error(`otp request failed: ${String(requested.status)}`);
  return call(h, 'POST', '/auth/otp/verify', {
    ...options,
    body: { mobile, code: h.sms.lastCodeFor(normalizeMobile(mobile) ?? mobile), client },
  });
}

export const STAFF_PASSWORD = 'a long enough password';

export interface LoggedInAccount {
  readonly id: string;
  readonly username: string;
  /** Mobile access token of an active session. */
  readonly access: string;
  readonly secret: Buffer;
  readonly lastStep: number;
}

/** A staff or center account with no session yet. */
export async function newAccount(
  h: Harness,
  kind: 'staff' | 'center' = 'staff',
  options: { verifiedMobile?: boolean } = {},
) {
  const username = `${kind}${randomBytes(4).toString('hex')}`;
  const id = await h.app
    .get(StaffAuthService)
    .createAccount({ kind, username, password: STAFF_PASSWORD });
  // Test data: a center account (a doctor or center manager) has a mobile it proved, as
  // linking and granting require from task 4-6; `verifiedMobile: false` for one without.
  if (kind === 'center' && options.verifiedMobile !== false) {
    await h.owner.query(
      'UPDATE user_accounts SET mobile = $1, mobile_verified_at = now() WHERE id = $2',
      [newMobile(), id],
    );
  }
  return { id, username };
}

/** A failed answer's body for an error message: secrets hidden, at most 500 characters. */
function failureBody(body: unknown): string {
  // Wrapped, so an empty body still gives a string.
  const text = JSON.stringify({ body }, (key, value: unknown) =>
    /secret|token|otp|password/i.test(key) ? '[hidden]' : value,
  );
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** A staff or center account that has enrolled TOTP and holds an active mobile session. */
export async function loggedInAccount(
  h: Harness,
  kind: 'staff' | 'center' = 'staff',
  options: CallOptions = {},
): Promise<LoggedInAccount> {
  const account = await newAccount(h, kind);
  const ip = options.ip ?? newIp();
  const login = await call(h, 'POST', '/auth/staff/login', {
    ip,
    body: { username: account.username, password: STAFF_PASSWORD, client: 'mobile' },
  });
  // Diagnostic only (owner, 1405/07/21): under the full run an enrolment once came back with
  // no secret. Each failed step now says its HTTP status and error body. Only failures are
  // printed, so no token or secret ever reaches the log.
  const pending = login.body['accessToken'];
  if (typeof pending !== 'string') {
    throw new Error(`staff login failed: ${String(login.status)} ${failureBody(login.body)}`);
  }
  const enroll = await call(h, 'POST', '/auth/totp/enroll', { ip, bearer: pending });
  if (typeof enroll.body['secret'] !== 'string') {
    throw new Error(`TOTP enroll failed: ${String(enroll.status)} ${failureBody(enroll.body)}`);
  }
  const secret = base32Decode(enroll.body['secret']);
  const step = totpStep(Date.now());
  const done = await call(h, 'POST', '/auth/totp/verify', {
    ip,
    bearer: pending,
    body: { code: hotp(secret, step) },
  });
  if (done.status !== 200) throw new Error(`TOTP enrollment failed: ${String(done.status)}`);
  return { ...account, secret, lastStep: step, access: done.body['accessToken'] as string };
}

/**
 * A new session for an account made by loggedInAccount(): password, then TOTP. For a test
 * that outlives an access token. The code is for the next step not yet used (replay is
 * refused), so two logins within one 30-second step still work once.
 */
export async function relogin(h: Harness, account: LoggedInAccount): Promise<LoggedInAccount> {
  const ip = newIp();
  const login = await call(h, 'POST', '/auth/staff/login', {
    ip,
    body: { username: account.username, password: STAFF_PASSWORD, client: 'mobile' },
  });
  const step = Math.max(totpStep(Date.now()), account.lastStep + 1);
  const done = await call(h, 'POST', '/auth/totp/verify', {
    ip,
    bearer: login.body['accessToken'] as string,
    body: { code: hotp(account.secret, step) },
  });
  if (done.status !== 200) throw new Error(`TOTP login failed: ${String(done.status)}`);
  return { ...account, lastStep: step, access: done.body['accessToken'] as string };
}

/** The actor of a direct service call made on behalf of `accountId`. */
export const actorFor = (accountId: string): Actor => ({
  accountId,
  sessionId: null,
  ip: null,
  roles: [],
});

/** Grants a role from the command line (actor `cli`); returns the assignment id. */
export async function grantRole(
  h: Harness,
  accountId: string,
  roleCode: string,
  // R18 (task 9-3): an advisor is granted its own scope only.
  scope: ScopeInput = roleCode === 'advisor' ? { kind: 'own' } : { kind: 'global' },
): Promise<string> {
  // Test data: a center manager's account has a mobile it proved, as the grant requires
  // from task 4-6 (the refusal itself is tested through the service, account-mobile).
  if (roleCode === 'center_manager') {
    await h.owner.query(
      `UPDATE user_accounts SET mobile = coalesce(mobile, $1), mobile_verified_at = now()
        WHERE id = $2 AND mobile_verified_at IS NULL`,
      [newMobile(), accountId],
    );
  }
  const { id } = await h.app
    .get(AccessService)
    .assignRole(CLI_ACTOR, { accountId, roleCode, scope, reason: 'test fixture' });
  return id;
}

/** Everything, everywhere: for creating fixtures through the service. */
const FIXTURE_ACCESS: EffectiveAccess = {
  accountId: '',
  roles: [],
  permissions: new Set(),
  scopes: [{ kind: 'global' }],
};

/** Creates a node of the center tree; returns its id. */
export async function createNode(
  h: Harness,
  kind: 'center' | 'doctor' | 'secretary',
  options: { parentId?: string; accountId?: string; cityCode?: string } = {},
): Promise<string> {
  const node = await h.app.get(AccessService).createOrgNode(CLI_ACTOR, FIXTURE_ACCESS, {
    kind,
    parentId: options.parentId ?? null,
    name: `${kind} ${randomBytes(3).toString('hex')}`,
    cityCode: options.parentId ? null : (options.cityCode ?? 'tehran'),
    accountId: options.accountId ?? null,
    reason: 'test fixture',
  });
  return node.id;
}
