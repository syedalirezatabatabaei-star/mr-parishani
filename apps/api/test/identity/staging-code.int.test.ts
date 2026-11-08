import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newMobile, startHarness, type Harness } from './harness';

/**
 * Task 9-4 (owner 1405/07/18): on the tester's staging every patient signs in with one fixed
 * code; its limits stay. This file's API starts with the staging settings (its own process).
 */
const FIXED = '424242';
let h: Harness;

beforeAll(async () => {
  process.env['DEPLOY_ENV'] = 'staging';
  process.env['STAGING_FIXED_LOGIN_CODE'] = FIXED;
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
  delete process.env['DEPLOY_ENV'];
  delete process.env['STAGING_FIXED_LOGIN_CODE'];
});

describe('the staging fixed login code', () => {
  it('signs a patient in, and nothing else does', async () => {
    const mobile = `0${newMobile()}`;
    expect((await call(h, 'POST', '/auth/otp/request', { body: { mobile } })).status).toBe(202);
    expect(h.sms.sent.at(-1)?.code).toBe(FIXED);
    const wrong = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: '123456', client: 'mobile' },
    });
    expect(wrong.status).toBe(401);
    const right = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: FIXED, client: 'mobile' },
    });
    expect(right.status).toBe(200);
    // Spent: the same code does not sign in twice without a new request.
    const again = await call(h, 'POST', '/auth/otp/verify', {
      body: { mobile, code: FIXED, client: 'mobile' },
    });
    expect(again.status).toBe(401);
  });
});
