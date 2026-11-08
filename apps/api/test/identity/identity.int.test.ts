import { randomBytes } from 'node:crypto';
import { toPersianDigits } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtpLoginService } from '../../src/modules/identity/otp-login.service';
import { StaffAuthService } from '../../src/modules/identity/staff-auth.service';
import { TotpResetService } from '../../src/modules/identity/totp-reset.service';
import { base32Decode, hotp, totpStep } from '../../src/modules/identity/totp';
import {
  actorFor,
  call,
  cookieValue,
  loggedInAccount,
  newIp,
  newMobile,
  otpLogin,
  relogin,
  STAFF_PASSWORD,
  startHarness,
  WEB_ORIGIN,
  type Harness,
} from './harness';

let h: Harness;

beforeAll(async () => {
  // The Person link is tested against a stand-in that can fail on demand.
  h = await startHarness({ fakePersons: true });
});

afterAll(async () => {
  await h.close();
});

const wrongCodeFor = (mobile: string) => {
  const right = h.sms.lastCodeFor(mobile);
  return right === '000000' ? '111111' : '000000';
};

describe('patient OTP login', () => {
  it('logs in with the code sent by SMS and creates the account', async () => {
    const mobile = newMobile();
    const res = await otpLogin(h, `0${mobile}`, 'mobile');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stage: 'active' });
    expect(typeof res.body['accessToken']).toBe('string');
    expect(typeof res.body['refreshToken']).toBe('string');

    const me = await call(h, 'GET', '/auth/me', { bearer: res.body['accessToken'] as string });
    expect(me.status).toBe(200);
    expect(me.body['stage']).toBe('active');
  });

  it('sends the code for 3 minutes and answers the same whether or not the account exists', async () => {
    const known = newMobile();
    await otpLogin(h, known, 'mobile');
    await h.redis.del(`identity:otp-cooldown:${known}`);

    const forKnown = await call(h, 'POST', '/auth/otp/request', { body: { mobile: known } });
    const forUnknown = await call(h, 'POST', '/auth/otp/request', {
      body: { mobile: newMobile() },
    });
    expect(forKnown.status).toBe(202);
    expect(forUnknown.status).toBe(202);
    expect(forKnown.body).toEqual(forUnknown.body);
    expect(forKnown.body).toEqual({ expiresInSeconds: 180, resendAfterSeconds: 60 });
  });

  it('accepts a code only once', async () => {
    const mobile = newMobile();
    const first = await otpLogin(h, mobile, 'mobile');
    expect(first.status).toBe(200);
    const again = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: h.sms.lastCodeFor(mobile), client: 'mobile' },
    });
    expect(again.status).toBe(401);
  });

  it('rejects an expired code', async () => {
    const mobile = newMobile();
    await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    const otp = h.app.get(OtpLoginService);
    const later = new Date(Date.now() + 181_000);
    await expect(
      otp.verify(
        mobile,
        h.sms.lastCodeFor(mobile),
        'mobile',
        { ip: null, deviceId: null, userAgent: null },
        later,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('ACCEPTANCE: the 6th wrong code locks the mobile temporarily', async () => {
    const mobile = newMobile();
    await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    const code = h.sms.lastCodeFor(mobile);
    const wrong = wrongCodeFor(mobile);

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await call(h, 'POST', '/auth/otp/verify', {
        body: { mobile, code: wrong, client: 'mobile' },
      });
      expect(res.status, `attempt ${String(attempt)}`).toBe(401);
    }
    const sixth = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: wrong, client: 'mobile' },
    });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ error: 'locked' });

    // Locked: even the right code, and new codes, are refused.
    const withRightCode = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code, client: 'mobile' },
    });
    expect(withRightCode.status).toBe(429);
    const newCode = await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    expect(newCode.status).toBe(429);

    // Temporary: 15 minutes.
    const ttl = await h.redis.ttl(`identity:lock:otp:${mobile}`);
    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);

    // When the lock expires, the old code is gone and a new one works.
    await h.redis.del(`identity:lock:otp:${mobile}`, `identity:otp-cooldown:${mobile}`);
    const oldCode = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code, client: 'mobile' },
    });
    expect(oldCode.status).toBe(401);
    const relogin = await otpLogin(h, mobile, 'mobile');
    expect(relogin.status).toBe(200);
  });

  it('resets the failure count after a successful login', async () => {
    const mobile = newMobile();
    await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    for (let i = 0; i < 5; i++) {
      await call(h, 'POST', '/auth/otp/verify', {
        body: { mobile, code: wrongCodeFor(mobile), client: 'mobile' },
      });
    }
    const ok = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: h.sms.lastCodeFor(mobile), client: 'mobile' },
    });
    expect(ok.status).toBe(200);
    expect(await h.redis.exists(`identity:fail:otp:${mobile}`)).toBe(0);
  });

  it('waits 60 seconds between codes for the same mobile', async () => {
    const mobile = newMobile();
    expect((await call(h, 'POST', '/auth/otp/request', { body: { mobile } })).status).toBe(202);
    const again = await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ error: 'resend_too_soon' });
  });

  it('sends at most 8 codes per mobile per hour', async () => {
    const mobile = newMobile();
    for (let i = 1; i <= 8; i++) {
      await h.redis.del(`identity:otp-cooldown:${mobile}`);
      expect((await call(h, 'POST', '/auth/otp/request', { body: { mobile } })).status).toBe(202);
    }
    await h.redis.del(`identity:otp-cooldown:${mobile}`);
    const ninth = await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    expect(ninth.status).toBe(429);
    expect(ninth.body).toMatchObject({ error: 'rate_limited' });
  });

  it('sends at most 20 codes per IP per hour', async () => {
    const ip = newIp();
    for (let i = 1; i <= 20; i++) {
      const res = await call(h, 'POST', '/auth/otp/request', { ip, body: { mobile: newMobile() } });
      expect(res.status).toBe(202);
    }
    const res = await call(h, 'POST', '/auth/otp/request', { ip, body: { mobile: newMobile() } });
    expect(res.status).toBe(429);
  });

  it('sends at most 10 codes per device per hour', async () => {
    const deviceId = randomBytes(18).toString('base64url');
    for (let i = 1; i <= 10; i++) {
      const res = await call(h, 'POST', '/auth/otp/request', {
        deviceId,
        body: { mobile: newMobile() },
      });
      expect(res.status).toBe(202);
    }
    const res = await call(h, 'POST', '/auth/otp/request', {
      deviceId,
      body: { mobile: newMobile() },
    });
    expect(res.status).toBe(429);
  });

  it('refuses a malformed device id instead of skipping the per-device limit', async () => {
    const res = await call(h, 'POST', '/auth/otp/request', {
      body: { mobile: newMobile() },
      deviceId: 'not a device id!',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_device_id' });
  });

  it('a request refused by a limit neither starts the cooldown nor replaces the code sent', async () => {
    const mobile = newMobile();
    await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    const first = h.sms.lastCodeFor(mobile);
    await h.redis.del(`identity:otp-cooldown:${mobile}`);
    await h.redis.set(`identity:otp-send:mobile:${mobile}`, '8', 'EX', 3600);

    const refused = await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'rate_limited' });
    expect(await h.redis.ttl(`identity:otp-cooldown:${mobile}`)).toBe(-2);

    const login = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: first, client: 'mobile' },
    });
    expect(login.status).toBe(200);
  });

  it('a code whose SMS cannot be queued frees the cooldown and keeps the previous code', async () => {
    const mobile = newMobile();
    await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    const first = h.sms.lastCodeFor(mobile);
    await h.redis.del(`identity:otp-cooldown:${mobile}`);

    h.sms.failNext = true;
    const failed = await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    expect(failed.status).toBe(500);
    expect(await h.redis.ttl(`identity:otp-cooldown:${mobile}`)).toBe(-2);

    const login = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: first, client: 'mobile' },
    });
    expect(login.status).toBe(200);
  });

  it('rejects an invalid mobile', async () => {
    const res = await call(h, 'POST', '/auth/otp/request', { body: { mobile: '02112345678' } });
    expect(res.status).toBe(400);
  });

  it('accepts the code in Persian digits', async () => {
    const mobile = newMobile();
    const requested = await call(h, 'POST', '/auth/otp/request', { body: { mobile } });
    expect(requested.status).toBe(202);

    const res = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: toPersianDigits(h.sms.lastCodeFor(mobile)), client: 'mobile' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stage: 'active' });
  });

  it('lets a mobile log in again after its account was soft-deleted', async () => {
    const mobile = newMobile();
    expect((await otpLogin(h, mobile, 'mobile')).status).toBe(200);

    // The unique key skips soft-deleted rows, so the mobile is free again (rule 7).
    await h.owner.query('UPDATE user_accounts SET deleted_at = now() WHERE mobile = $1', [mobile]);
    await h.redis.del(`identity:otp-cooldown:${mobile}`);

    const again = await otpLogin(h, mobile, 'mobile');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ stage: 'active' });

    const rows = await h.owner.query<{ count: string }>(
      'SELECT count(*) AS count FROM user_accounts WHERE mobile = $1',
      [mobile],
    );
    expect(rows.rows[0]?.count).toBe('2');
  });
});

describe('linking a patient to their Person', () => {
  it('links the new account to the Person of that mobile, once', async () => {
    const mobile = newMobile();
    // A Person already exists for this mobile (e.g. from a lead).
    const existing = await h.persons.findOrCreateByMobile(mobile);
    const callsBefore = h.persons.calls;

    await otpLogin(h, mobile, 'mobile');
    await h.redis.del(`identity:otp-cooldown:${mobile}`);
    await otpLogin(h, mobile, 'mobile');

    const { rows } = await h.owner.query<{ person_id: string }>(
      "SELECT person_id FROM user_accounts WHERE kind = 'patient' AND mobile = $1",
      [mobile],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.person_id).toBe(existing.personId);
    // Asked once: the second login found the link already made.
    expect(h.persons.calls - callsBefore).toBe(1);
  });

  it('still logs in if the directory is down, and links on the next login', async () => {
    const mobile = newMobile();
    h.persons.failNext = true;
    expect((await otpLogin(h, mobile, 'mobile')).status).toBe(200);
    const before = await h.owner.query('SELECT person_id FROM user_accounts WHERE mobile = $1', [
      mobile,
    ]);
    expect(before.rows[0]).toMatchObject({ person_id: null });

    await h.redis.del(`identity:otp-cooldown:${mobile}`);
    await otpLogin(h, mobile, 'mobile');
    const after = await h.owner.query<{ person_id: string | null }>(
      'SELECT person_id FROM user_accounts WHERE mobile = $1',
      [mobile],
    );
    expect(after.rows[0]?.person_id).toBe(h.persons.persons.get(mobile));
  });
});

describe('mobile refresh tokens', () => {
  it('ACCEPTANCE: a used refresh token is never accepted again, and its reuse ends the session', async () => {
    const login = await otpLogin(h, newMobile(), 'mobile');
    const firstAccess = login.body['accessToken'] as string;
    const firstRefresh = login.body['refreshToken'] as string;

    const rotated = await call(h, 'POST', '/auth/refresh', {
      body: { refreshToken: firstRefresh },
    });
    expect(rotated.status).toBe(200);
    const secondAccess = rotated.body['accessToken'] as string;
    const secondRefresh = rotated.body['refreshToken'] as string;
    expect(secondRefresh).not.toBe(firstRefresh);

    // The old access token died with the rotation; the new one works.
    expect((await call(h, 'GET', '/auth/me', { bearer: firstAccess })).status).toBe(401);
    expect((await call(h, 'GET', '/auth/me', { bearer: secondAccess })).status).toBe(200);

    // Reuse of the first refresh token: refused...
    const reused = await call(h, 'POST', '/auth/refresh', { body: { refreshToken: firstRefresh } });
    expect(reused.status).toBe(401);
    // ...and the whole session is revoked, including the legitimate newer tokens.
    expect((await call(h, 'GET', '/auth/me', { bearer: secondAccess })).status).toBe(401);
    const newer = await call(h, 'POST', '/auth/refresh', { body: { refreshToken: secondRefresh } });
    expect(newer.status).toBe(401);
  });

  it('refuses an unknown refresh token', async () => {
    const res = await call(h, 'POST', '/auth/refresh', { body: { refreshToken: 'nope' } });
    expect(res.status).toBe(401);
  });
});

describe('web sessions', () => {
  it('uses a __Host- cookie that is HttpOnly, Secure and SameSite, plus a CSRF token', async () => {
    const res = await otpLogin(h, newMobile(), 'web', { origin: WEB_ORIGIN });
    expect(res.status).toBe(200);
    const cookie = res.cookies.get('__Host-sid') ?? '';
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(typeof res.body['csrfToken']).toBe('string');
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it('requires the CSRF token and an allowed origin for state-changing requests', async () => {
    const res = await otpLogin(h, newMobile(), 'web', { origin: WEB_ORIGIN });
    const cookie = cookieValue(res.cookies.get('__Host-sid'));
    const csrf = res.body['csrfToken'] as string;

    // Reading needs no CSRF token.
    expect((await call(h, 'GET', '/auth/sessions', { cookie })).status).toBe(200);

    const noToken = await call(h, 'POST', '/auth/logout-all', { cookie, origin: WEB_ORIGIN });
    expect(noToken.status).toBe(403);
    const wrongToken = await call(h, 'POST', '/auth/logout-all', {
      cookie,
      origin: WEB_ORIGIN,
      csrf: `${csrf}x`,
    });
    expect(wrongToken.status).toBe(403);
    const noOrigin = await call(h, 'POST', '/auth/logout-all', { cookie, csrf });
    expect(noOrigin.status).toBe(403);
    const foreign = await call(h, 'POST', '/auth/logout-all', {
      cookie,
      csrf,
      origin: 'https://evil.example',
    });
    expect(foreign.status).toBe(403);

    const ok = await call(h, 'POST', '/auth/logout-all', { cookie, csrf, origin: WEB_ORIGIN });
    expect(ok.status).toBe(200);
    expect((await call(h, 'GET', '/auth/sessions', { cookie })).status).toBe(401);
  });

  it('refuses login requests a foreign site sends from the browser (login CSRF)', async () => {
    const res = await call(h, 'POST', '/auth/otp/request', {
      origin: 'https://evil.example',
      body: { mobile: newMobile() },
    });
    expect(res.status).toBe(403);
  });

  it('answers CORS preflights for the web origins only, with credentials', async () => {
    const preflight = (origin: string) =>
      fetch(`${h.baseUrl}/auth/sessions`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'DELETE',
          'access-control-request-headers': 'x-csrf-token',
        },
      });
    const allowed = await preflight(WEB_ORIGIN);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('x-csrf-token');

    const foreign = await preflight('https://evil.example');
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    // No framework banner on any answer.
    expect(allowed.headers.get('x-powered-by')).toBeNull();
  });

  it('task 9-3 (R9): every answer is never sniffed, never cached, never framed', async () => {
    for (const path of ['/auth/me', '/catalog/fields', '/no-such-route']) {
      const res = await fetch(`${h.baseUrl}${path}`, { headers: { 'x-forwarded-for': newIp() } });
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
    }
  });

  it('gives the CSRF token back after a page reload', async () => {
    const res = await otpLogin(h, newMobile(), 'web', { origin: WEB_ORIGIN });
    const me = await call(h, 'GET', '/auth/me', {
      cookie: cookieValue(res.cookies.get('__Host-sid')),
    });
    expect(me.body['csrfToken']).toBe(res.body['csrfToken']);
  });
});

describe('task 9-3 (R2): a staff member changes their own password', () => {
  it('with the current one; other sessions end, this one stays; the new one signs in', async () => {
    const account = await loggedInAccount(h, 'staff');
    const other = await relogin(h, account);
    const change = (body: Record<string, string>) =>
      call(h, 'POST', '/auth/password', { bearer: account.access, body });
    // The current password wrong: refused, as a failed login.
    expect(
      (
        await change({
          currentPassword: 'not the password',
          newPassword: 'a brand new long phrase',
        })
      ).status,
    ).toBe(401);
    // A weak one or the same one: refused.
    expect(
      (await change({ currentPassword: STAFF_PASSWORD, newPassword: 'aaaaaaaaaaaaaaaa' })).body,
    ).toMatchObject({ error: 'password_repeated' });
    expect(
      (await change({ currentPassword: STAFF_PASSWORD, newPassword: STAFF_PASSWORD })).body,
    ).toMatchObject({ error: 'password_unchanged' });
    const done = await change({
      currentPassword: STAFF_PASSWORD,
      newPassword: 'a brand new long phrase',
    });
    expect(done).toMatchObject({ status: 200, body: { otherSessionsEnded: 1 } });
    // This session still works; the other one is over.
    expect((await call(h, 'GET', '/auth/me', { bearer: account.access })).status).toBe(200);
    expect((await call(h, 'GET', '/auth/me', { bearer: other.access })).status).toBe(401);
    const login = await call(h, 'POST', '/auth/staff/login', {
      ip: newIp(),
      body: { username: account.username, password: 'a brand new long phrase', client: 'mobile' },
    });
    expect(login.status).toBe(200);
    const { rows } = await h.owner.query(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'identity.password_changed'`,
      [account.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('task 9-3 (R5): every public endpoint has a limit per client address', () => {
  it('past it, 429 with when to come back; another address is not counted', async () => {
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('identity.public_rate_limit', 'global', '{"perIpPerMinute": 3}', now(), 'approved',
         'آزمون', now())`,
    );
    try {
      const ip = newIp();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await call(h, 'GET', '/catalog/fields', { ip })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      const refused = await call(h, 'GET', '/catalog/fields', { ip });
      expect(refused.body).toMatchObject({ error: 'rate_limited' });
      expect((await call(h, 'GET', '/catalog/fields', { ip: newIp() })).status).toBe(200);
    } finally {
      await h.owner.query(
        `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
         VALUES ('identity.public_rate_limit', 'global', '{"perIpPerMinute": 300}', now(),
           'approved', 'آزمون', now())`,
      );
    }
  });
});

describe('task 9-3 (R1): a session has an absolute lifetime', () => {
  it('a web session signed in 13 hours ago is over, however active', async () => {
    const res = await otpLogin(h, newMobile(), 'web', { origin: WEB_ORIGIN });
    const cookie = cookieValue(res.cookies.get('__Host-sid'));
    expect((await call(h, 'GET', '/auth/me', { cookie })).status).toBe(200);
    // Signed in 13 hours ago (past the 12-hour default), its idle deadline still ahead.
    await h.owner.query(
      `UPDATE sessions SET authenticated_at = now() - interval '13 hours',
         token_expires_at = now() + interval '1 hour'
       WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)`,
    );
    expect((await call(h, 'GET', '/auth/me', { cookie })).status).toBe(401);
  });

  it('a mobile session signed in 31 days ago refreshes no more', async () => {
    const login = await otpLogin(h, newMobile(), 'mobile');
    await h.owner.query(
      `UPDATE sessions SET authenticated_at = now() - interval '31 days'
       WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)`,
    );
    const refreshed = await call(h, 'POST', '/auth/refresh', {
      body: { refreshToken: login.body['refreshToken'] as string },
    });
    expect(refreshed).toMatchObject({ status: 401, body: { error: 'invalid_refresh_token' } });
  });
});

describe('staff login with password and TOTP', () => {
  const password = 'a long enough password';

  async function newStaff() {
    const username = `staff${randomBytes(4).toString('hex')}`;
    const id = await h.app
      .get(StaffAuthService)
      .createAccount({ kind: 'staff', username, password });
    return { id, username };
  }

  async function enrolledStaff() {
    const staff = await newStaff();
    const login = await call(h, 'POST', '/auth/staff/login', {
      body: { username: staff.username, password, client: 'mobile' },
    });
    const pending = login.body['accessToken'] as string;
    const enroll = await call(h, 'POST', '/auth/totp/enroll', { bearer: pending });
    const secret = base32Decode(enroll.body['secret'] as string);
    const step = totpStep(Date.now());
    const done = await call(h, 'POST', '/auth/totp/verify', {
      bearer: pending,
      body: { code: hotp(secret, step) },
    });
    expect(done.status).toBe(200);
    return { ...staff, secret, lastStep: step, access: done.body['accessToken'] as string };
  }

  it('rejects wrong passwords and unknown users with the same answer', async () => {
    const staff = await newStaff();
    const wrong = await call(h, 'POST', '/auth/staff/login', {
      body: { username: staff.username, password: 'wrong password!!', client: 'web' },
    });
    const unknown = await call(h, 'POST', '/auth/staff/login', {
      body: { username: 'nobody-here', password: 'whatever password', client: 'web' },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('makes TOTP enrollment mandatory: the password alone reaches nothing else', async () => {
    const staff = await newStaff();
    const login = await call(h, 'POST', '/auth/staff/login', {
      body: { username: staff.username, password, client: 'mobile' },
    });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ stage: 'mfa_pending', next: 'totp_enroll' });
    expect(login.body).not.toHaveProperty('refreshToken');
    const pending = login.body['accessToken'] as string;

    const sessions = await call(h, 'GET', '/auth/sessions', { bearer: pending });
    expect(sessions.status).toBe(403);
    expect(sessions.body).toMatchObject({ error: 'mfa_required' });

    const enroll = await call(h, 'POST', '/auth/totp/enroll', { bearer: pending });
    expect(enroll.status).toBe(200);
    expect(enroll.body['otpauthUri']).toMatch(/^otpauth:\/\/totp\//);

    const code = hotp(base32Decode(enroll.body['secret'] as string), totpStep(Date.now()));
    const verified = await call(h, 'POST', '/auth/totp/verify', {
      bearer: pending,
      body: { code },
    });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ stage: 'active' });

    // The pending session was replaced, not upgraded.
    expect((await call(h, 'GET', '/auth/me', { bearer: pending })).status).toBe(401);
    const active = verified.body['accessToken'] as string;
    expect((await call(h, 'GET', '/auth/sessions', { bearer: active })).status).toBe(200);
  });

  it('stores the TOTP secret encrypted', async () => {
    const staff = await enrolledStaff();
    const { rows } = await h.owner.query<{ totp_secret_encrypted: string }>(
      'SELECT totp_secret_encrypted FROM user_accounts WHERE id = $1',
      [staff.id],
    );
    expect(rows[0]?.totp_secret_encrypted).toMatch(/^v1\./);
  });

  it('never accepts the same TOTP code twice', async () => {
    const staff = await enrolledStaff();
    const login = await call(h, 'POST', '/auth/staff/login', {
      body: { username: staff.username, password, client: 'mobile' },
    });
    expect(login.body).toMatchObject({ next: 'totp' });
    const replay = await call(h, 'POST', '/auth/totp/verify', {
      bearer: login.body['accessToken'] as string,
      body: { code: hotp(staff.secret, staff.lastStep) },
    });
    expect(replay.status).toBe(401);
  });

  it('locks the username after 6 wrong passwords', async () => {
    const staff = await newStaff();
    for (let i = 1; i <= 5; i++) {
      const res = await call(h, 'POST', '/auth/staff/login', {
        body: { username: staff.username, password: 'wrong password!!', client: 'web' },
      });
      expect(res.status).toBe(401);
    }
    const sixth = await call(h, 'POST', '/auth/staff/login', {
      body: { username: staff.username, password: 'wrong password!!', client: 'web' },
    });
    expect(sixth.status).toBe(429);
    const right = await call(h, 'POST', '/auth/staff/login', {
      body: { username: staff.username, password, client: 'web' },
    });
    expect(right.status).toBe(429);
  });

  it('a correct password clears the earlier wrong passwords', async () => {
    const staff = await newStaff();
    const attempt = (pw: string) =>
      call(h, 'POST', '/auth/staff/login', {
        body: { username: staff.username, password: pw, client: 'web' },
      });
    for (let i = 1; i <= 5; i++) expect((await attempt('wrong password!!')).status).toBe(401);
    expect((await attempt(password)).status).toBe(200);
    // Counting starts over: five more typos are still not a lock.
    for (let i = 1; i <= 5; i++) expect((await attempt('wrong password!!')).status).toBe(401);
  });

  it('a correct password does not clear the count of wrong TOTP codes', async () => {
    const staff = await enrolledStaff();
    const now = totpStep(Date.now());
    const valid = new Set([now - 1, now, now + 1].map((s) => hotp(staff.secret, s)));
    const wrong = ['000000', '111111', '222222'].find((c) => !valid.has(c)) ?? '333333';
    const login = async () =>
      (
        await call(h, 'POST', '/auth/staff/login', {
          body: { username: staff.username, password, client: 'mobile' },
        })
      ).body['accessToken'] as string;

    const first = await login();
    for (let i = 1; i <= 5; i++) {
      const res = await call(h, 'POST', '/auth/totp/verify', {
        bearer: first,
        body: { code: wrong },
      });
      expect(res.status).toBe(401);
    }
    const second = await login();
    const sixth = await call(h, 'POST', '/auth/totp/verify', {
      bearer: second,
      body: { code: wrong },
    });
    expect(sixth.status).toBe(429);
  });

  it('ends every session at once when an account is disabled', async () => {
    const staff = await enrolledStaff();
    expect((await call(h, 'GET', '/auth/me', { bearer: staff.access })).status).toBe(200);
    await h.owner.query("UPDATE user_accounts SET status = 'disabled' WHERE id = $1", [staff.id]);
    expect((await call(h, 'GET', '/auth/me', { bearer: staff.access })).status).toBe(401);
  });

  describe('TOTP reset needs two different people', () => {
    it('refuses the requester, the target and a self-request; a second person resets it', async () => {
      const target = await enrolledStaff();
      const maker = await newStaff();
      const checker = await newStaff();
      const resets = h.app.get(TotpResetService);

      await expect(
        resets.request(actorFor(target.id), target.id, 'lost phone'),
      ).rejects.toMatchObject({
        status: 403,
      });
      const requestId = await resets.request(actorFor(maker.id), target.id, 'lost phone');
      await expect(resets.approve(actorFor(maker.id), requestId)).rejects.toMatchObject({
        status: 403,
      });
      await expect(resets.approve(actorFor(target.id), requestId)).rejects.toMatchObject({
        status: 403,
      });

      await resets.approve(actorFor(checker.id), requestId);
      // The target is logged out everywhere and must enroll again.
      expect((await call(h, 'GET', '/auth/me', { bearer: target.access })).status).toBe(401);
      const login = await call(h, 'POST', '/auth/staff/login', {
        body: { username: target.username, password, client: 'web' },
      });
      expect(login.body).toMatchObject({ next: 'totp_enroll' });
      await expect(resets.approve(actorFor(checker.id), requestId)).rejects.toMatchObject({
        status: 409,
      });
    });

    it('is also enforced by the database', async () => {
      const target = await newStaff();
      await expect(
        h.owner.query(
          "INSERT INTO totp_reset_requests (target_account_id, requested_by, reason) VALUES ($1, $1, 'x')",
          [target.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});

describe('devices', () => {
  it('lists my devices, logs out one of them, and cannot touch another account', async () => {
    const mobile = newMobile();
    const phone = await otpLogin(h, mobile, 'mobile');
    await h.redis.del(`identity:otp-cooldown:${mobile}`);
    const tablet = await otpLogin(h, mobile, 'mobile');
    const phoneToken = phone.body['accessToken'] as string;
    const tabletToken = tablet.body['accessToken'] as string;

    const list = await call(h, 'GET', '/auth/sessions', { bearer: phoneToken });
    const sessions = list.body as unknown as { id: string; current: boolean }[];
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    const tabletSession = sessions.find((s) => !s.current);

    // Someone else cannot revoke my session, and learns nothing: 404.
    const stranger = await otpLogin(h, newMobile(), 'mobile');
    const idor = await call(h, 'DELETE', `/auth/sessions/${tabletSession?.id ?? ''}`, {
      bearer: stranger.body['accessToken'] as string,
    });
    expect(idor.status).toBe(404);
    expect((await call(h, 'GET', '/auth/me', { bearer: tabletToken })).status).toBe(200);

    const revoked = await call(h, 'DELETE', `/auth/sessions/${tabletSession?.id ?? ''}`, {
      bearer: phoneToken,
    });
    expect(revoked.status).toBe(204);
    expect((await call(h, 'GET', '/auth/me', { bearer: tabletToken })).status).toBe(401);
    expect((await call(h, 'GET', '/auth/me', { bearer: phoneToken })).status).toBe(200);
  });

  it('logs out of all devices', async () => {
    const mobile = newMobile();
    const a = await otpLogin(h, mobile, 'mobile');
    await h.redis.del(`identity:otp-cooldown:${mobile}`);
    const b = await otpLogin(h, mobile, 'mobile');
    const res = await call(h, 'POST', '/auth/logout-all', {
      bearer: a.body['accessToken'] as string,
    });
    expect(res.body).toEqual({ revoked: 2 });
    expect(
      (await call(h, 'GET', '/auth/me', { bearer: b.body['accessToken'] as string })).status,
    ).toBe(401);
    const refresh = await call(h, 'POST', '/auth/refresh', {
      body: { refreshToken: b.body['refreshToken'] as string },
    });
    expect(refresh.status).toBe(401);
  });

  it('keeps logged-out sessions as rows (no physical delete)', async () => {
    const res = await h.owner.query(
      "SELECT count(*)::int AS n FROM sessions WHERE revoke_reason = 'logout_all'",
    );
    expect((res.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('default deny', () => {
  it('an endpoint needing a permission is 401 anonymous and 403 without the permission', async () => {
    expect((await call(h, 'GET', '/probe')).status).toBe(401);
    const login = await otpLogin(h, newMobile(), 'mobile');
    const res = await call(h, 'GET', '/probe', { bearer: login.body['accessToken'] as string });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'permission_required' });
  });
});
