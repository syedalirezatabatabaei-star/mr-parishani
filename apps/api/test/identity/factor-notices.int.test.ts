import type { EventEnvelope } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_LOG, type AuditLog } from '../../src/common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import {
  NOTIFICATIONS,
  type NotificationsPort,
} from '../../src/common/notification/notifications.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { FactorNoticeConsumer, FactorNotices } from '../../src/modules/identity/factor-notices';
import { hotp, totpStep, base32Decode } from '../../src/modules/identity/totp';
import {
  actorFor,
  call,
  grantRole,
  loggedInAccount,
  newMobile,
  otpLogin,
  startHarness,
  STAFF_PASSWORD,
  type Harness,
  type LoggedInAccount,
} from './harness';

/**
 * Task 9-3, R2 (ASVS 2.2.3, 2.5.5): a login factor change is told to the account by SMS. The
 * notice and its outbox event are written in the change's own transaction; the SMS is
 * recorded by the consumer after the commit, under the notice's key. A changed mobile's
 * notice goes to the previous one. The event carries no mobile (rule 30). A failed SMS never
 * undoes the change: the consumer throws and the outbox retries it.
 */

let h: Harness;
let db: Database;

type Row = Record<string, unknown>;

const as = (a: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: a.access, ...(body === undefined ? {} : { body }) });

const setSms = (enabled: boolean) =>
  h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('identity.factor_change_sms', 'global', $1::jsonb, $2, 'approved', 'test', $2)`,
    [JSON.stringify({ enabled }), new Date()],
  );

const consumer = (notifications = h.app.get<NotificationsPort>(NOTIFICATIONS)) =>
  new FactorNoticeConsumer(
    { register: () => undefined },
    h.app.get<ConfigPort>(CONFIG),
    notifications,
    h.app.get<AuditLog>(AUDIT_LOG),
  );

const notices = async (accountId: string) =>
  (
    await h.owner.query<Row>(
      `SELECT id, event, audience, mobile FROM factor_change_notices
        WHERE account_id = $1 ORDER BY created_at`,
      [accountId],
    )
  ).rows;

/** The outbox events of the account's notices, as the worker would hand them over. */
async function events(accountId: string): Promise<EventEnvelope[]> {
  const { rows } = await h.owner.query<Row>(
    `SELECT id, event_type, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
      WHERE event_type = 'identity.factor_changed' AND aggregate_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return rows.map((r) => ({
    id: r['id'] as string,
    type: r['event_type'] as string,
    aggregateType: r['aggregate_type'] as string,
    aggregateId: r['aggregate_id'] as string,
    payload: r['payload'],
    occurredAt: (r['created_at'] as Date).toISOString(),
  }));
}

const deliver = (event: EventEnvelope, c = consumer()) =>
  db.transaction((tx) => c.handle(event, tx));

const dispatches = async (mobile: string) =>
  (
    await h.owner.query<Row>(
      `SELECT t.code, d.audience, d.category, d.status, d.mobile FROM sms_dispatches d
         JOIN sms_templates t ON t.id = d.template_id
        WHERE d.mobile = $1 ORDER BY d.created_at`,
      [mobile],
    )
  ).rows;

/** A signed-in staff account with a proved mobile. */
async function staffWithMobile() {
  const a = await loggedInAccount(h, 'staff');
  const mobile = newMobile();
  await h.owner.query(
    'UPDATE user_accounts SET mobile = $1, mobile_verified_at = now() WHERE id = $2',
    [mobile, a.id],
  );
  return { a, mobile };
}

beforeAll(async () => {
  h = await startHarness();
  db = h.app.get<Database>(DATABASE);
  await setSms(true);
}, 180_000);

afterAll(async () => {
  await setSms(false);
  await h.close();
});

describe('a password change', () => {
  it('records a notice and its event in its transaction; the SMS after it, once', async () => {
    const { a, mobile } = await staffWithMobile();
    const changed = await as(a, 'POST', '/auth/password', {
      currentPassword: STAFF_PASSWORD,
      newPassword: 'a brand new long passphrase',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    expect(await notices(a.id)).toEqual([
      expect.objectContaining({ event: 'password_changed', audience: 'staff', mobile }),
    ]);
    const [event] = await events(a.id);
    if (!event) throw new Error('no event');
    // Rule 30: the event names the notice, never the mobile.
    expect(JSON.stringify(event.payload)).not.toContain(mobile);
    // Nothing sent before the consumer runs (after the commit).
    expect(await dispatches(mobile)).toEqual([]);

    await deliver(event);
    await deliver(event);
    expect(await dispatches(mobile)).toEqual([
      {
        code: 'identity.factor.password_changed',
        audience: 'staff',
        category: 'urgent',
        status: 'pending',
        mobile,
      },
    ]);
  });

  it('that fails (a wrong current password) records nothing', async () => {
    const { a } = await staffWithMobile();
    const refused = await as(a, 'POST', '/auth/password', {
      currentPassword: 'not the password at all',
      newPassword: 'a brand new long passphrase',
    });
    expect(refused.status).toBe(401);
    expect(await notices(a.id)).toEqual([]);
    expect(await events(a.id)).toEqual([]);
  });

  it('without a proved mobile goes ahead; nobody to tell, and the audit says so', async () => {
    const a = await loggedInAccount(h, 'staff');
    const changed = await as(a, 'POST', '/auth/password', {
      currentPassword: STAFF_PASSWORD,
      newPassword: 'a brand new long passphrase',
    });
    expect(changed.status).toBe(200);
    expect(await notices(a.id)).toEqual([]);
    const { rows } = await h.owner.query<Row>(
      `SELECT after FROM audit_events
        WHERE action = 'identity.factor_notice_skipped' AND entity_id = $1`,
      [a.id],
    );
    expect(rows.map((r) => r['after'])).toEqual([
      { event: 'password_changed', reason: 'no_verified_mobile' },
    ]);
  });
});

describe('the SMS', () => {
  it('that fails leaves the change and its notice; the consumer throws for the outbox to retry', async () => {
    const { a, mobile } = await staffWithMobile();
    await as(a, 'POST', '/auth/password', {
      currentPassword: STAFF_PASSWORD,
      newPassword: 'a brand new long passphrase',
    });
    const [event] = await events(a.id);
    if (!event) throw new Error('no event');
    const failing = consumer({
      ...h.app.get<NotificationsPort>(NOTIFICATIONS),
      send: () => Promise.reject(new Error('provider down')),
    });
    await expect(deliver(event, failing)).rejects.toThrow('provider down');
    // The change stands: the new password signs in.
    const login = await call(h, 'POST', '/auth/staff/login', {
      body: { username: a.username, password: 'a brand new long passphrase', client: 'mobile' },
    });
    expect(login.status).toBe(200);
    expect(await notices(a.id)).toHaveLength(1);
    expect(await dispatches(mobile)).toEqual([]);
    // The retry, once the provider is back, sends it.
    await deliver(event);
    expect(await dispatches(mobile)).toHaveLength(1);
  });

  it('while the flag is off is set aside, audited, and never sent later', async () => {
    const { a, mobile } = await staffWithMobile();
    await as(a, 'POST', '/auth/password', {
      currentPassword: STAFF_PASSWORD,
      newPassword: 'a brand new long passphrase',
    });
    const [event] = await events(a.id);
    if (!event) throw new Error('no event');
    await setSms(false);
    try {
      await deliver(event);
    } finally {
      await setSms(true);
    }
    expect(await dispatches(mobile)).toEqual([]);
    const { rows } = await h.owner.query<Row>(
      `SELECT after->>'reason' AS reason FROM audit_events
        WHERE action = 'identity.factor_notice_skipped' AND entity_id = $1`,
      [a.id],
    );
    expect(rows.map((r) => r['reason'])).toEqual(['skipped_flag_off']);
  });
});

describe('a changed mobile', () => {
  // ADR-052: a staff member's verified mobile is replaced only by two others (see
  // staff-mobile-change.int.test.ts); a center account still replaces its own, as here.
  it('is told to the previous one; a first proved mobile tells nobody', async () => {
    const a = await loggedInAccount(h, 'center');
    // Starts without a mobile, as a staff member's first one did.
    await h.owner.query(
      'UPDATE user_accounts SET mobile = NULL, mobile_verified_at = NULL WHERE id = $1',
      [a.id],
    );
    const first = newMobile();
    const second = newMobile();
    const prove = async (mobile: string) => {
      expect((await as(a, 'POST', '/auth/mobile/request', { mobile })).status).toBe(202);
      const done = await as(a, 'POST', '/auth/mobile/verify', {
        mobile,
        code: h.sms.lastCodeFor(mobile),
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    };
    await prove(first);
    expect(await notices(a.id)).toEqual([]);
    await prove(second);
    expect(await notices(a.id)).toEqual([
      expect.objectContaining({ event: 'mobile_changed', audience: 'staff', mobile: first }),
    ]);
    const [event] = await events(a.id);
    if (!event) throw new Error('no event');
    await deliver(event);
    expect(await dispatches(first)).toEqual([
      expect.objectContaining({ code: 'identity.factor.mobile_changed' }),
    ]);
    expect(await dispatches(second)).toEqual([]);
  });

  it('of a patient: the notice and SMS are ready for the flow that will change it', async () => {
    const mobile = newMobile();
    const login = await otpLogin(h, mobile, 'mobile');
    expect(login.status).toBe(200);
    const { rows } = await h.owner.query<Row>(
      `SELECT id FROM user_accounts WHERE mobile = $1 AND kind = 'patient'`,
      [mobile],
    );
    const accountId = rows[0]?.['id'] as string;
    await db.transaction((tx) =>
      h.app
        .get(FactorNotices)
        .record(actorFor(accountId), { accountId, event: 'patient_mobile_changed', mobile }, tx),
    );
    const [event] = await events(accountId);
    if (!event) throw new Error('no event');
    await deliver(event);
    expect(await dispatches(mobile)).toEqual([
      expect.objectContaining({
        code: 'identity.factor.patient_mobile_changed',
        audience: 'patient',
        category: 'urgent',
      }),
    ]);
  });

  it('recorded in a transaction that rolls back leaves no notice and no event', async () => {
    const a = await loggedInAccount(h, 'staff');
    await expect(
      db.transaction(async (tx) => {
        await h.app
          .get(FactorNotices)
          .record(
            actorFor(a.id),
            { accountId: a.id, event: 'password_changed', mobile: newMobile() },
            tx,
          );
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await notices(a.id)).toEqual([]);
    expect(await events(a.id)).toEqual([]);
  });
});

describe('a TOTP reset', () => {
  it('approved tells the account; the new device confirmed after it tells it again', async () => {
    const [maker, checker] = await Promise.all([
      loggedInAccount(h, 'staff'),
      loggedInAccount(h, 'staff'),
    ]);
    await grantRole(h, maker.id, 'system_admin');
    await grantRole(h, checker.id, 'system_admin');
    const { a: target, mobile } = await staffWithMobile();
    // A first enrollment (the fixture's) is no change: nothing was told.
    expect(await notices(target.id)).toEqual([]);

    const requested = await as(maker, 'POST', '/identity/totp-resets', {
      targetAccountId: target.id,
      reason: 'گوشی گم شد',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const approved = await as(
      checker,
      'POST',
      `/identity/totp-resets/${requested.body['id'] as string}/approve`,
    );
    expect(approved.status).toBe(204);
    expect(await notices(target.id)).toEqual([
      expect.objectContaining({ event: 'totp_reset', mobile }),
    ]);

    // The target signs in again and enrolls a new device.
    const login = await call(h, 'POST', '/auth/staff/login', {
      body: { username: target.username, password: STAFF_PASSWORD, client: 'mobile' },
    });
    const pending = login.body['accessToken'] as string;
    const enroll = await call(h, 'POST', '/auth/totp/enroll', { bearer: pending });
    const secret = base32Decode(enroll.body['secret'] as string);
    const done = await call(h, 'POST', '/auth/totp/verify', {
      bearer: pending,
      body: { code: hotp(secret, totpStep(Date.now())) },
    });
    expect(done.status).toBe(200);
    expect((await notices(target.id)).map((n) => n['event'])).toEqual([
      'totp_reset',
      'totp_enrolled',
    ]);
    for (const event of await events(target.id)) await deliver(event);
    expect((await dispatches(mobile)).map((d) => d['code'])).toEqual([
      'identity.factor.totp_reset',
      'identity.factor.totp_enrolled',
    ]);
  });
});
