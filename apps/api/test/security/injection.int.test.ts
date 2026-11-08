import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newIp, startHarness, type Harness } from '../identity/harness';

/**
 * Task 9-3: ZAP's rescan (task 9-2's runner) flagged «SQL Injection» (plugin 40018, boolean
 * based) on four public endpoints, after the public rate limit (R5) was in place. Each pair of
 * payloads ZAP compared, sent here from a fresh client address each, must answer alike: if
 * the SQL were built from the value, `AND 1=1` and `AND 1=2` would differ. Every query is
 * parameterized (drizzle and the `sql` template); this test keeps it so.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

const PAIRS: readonly [string, string][] = [
  ["ZAP' AND '1'='1' -- ", "ZAP' AND '1'='2' -- "],
  ['ZAP AND 1=1 -- ', 'ZAP AND 1=2 -- '],
  ["x' OR '1'='1' -- ", "x' AND '1'='1' -- "],
  ['John Doe OR 1=1 -- ', 'John Doe AND 1=1 -- '],
];

async function answer(method: string, path: string, body?: unknown) {
  const res = await call(h, method, path, { ip: newIp(), ...(body === undefined ? {} : { body }) });
  return { status: res.status, body: res.body };
}

describe('boolean SQL payloads change nothing (ZAP 40018, task 9-3)', () => {
  // A fresh username per pair: five failures lock an account (429 `locked`), which is the
  // response difference ZAP read as a boolean injection.
  let user = 0;
  it.each(PAIRS)('staff login password: %s / %s', async (a, b) => {
    const username = `nobody${String(++user)}`;
    const send = (password: string) =>
      answer('POST', '/auth/staff/login', { username, password, client: 'mobile' });
    expect(await send(a)).toEqual(await send(b));
  });

  it.each(PAIRS)('the login code: %s / %s', async (a, b) => {
    const send = (code: string) =>
      answer('POST', '/auth/otp/verify', { mobile: '09121234567', code, client: 'mobile' });
    const mobile = (m: string) =>
      answer('POST', '/auth/otp/verify', { mobile: m, code: '123456', client: 'mobile' });
    expect(await send(a)).toEqual(await send(b));
    expect(await mobile(a)).toEqual(await mobile(b));
  });

  it.each(PAIRS)('holidays from: %s / %s', async (a, b) => {
    const send = (from: string) =>
      answer(
        'GET',
        `/calendar/holidays?${new URLSearchParams({ from, to: '2026-12-01' }).toString()}`,
      );
    expect(await send(a)).toEqual(await send(b));
  });

  it.each(PAIRS)('search cityCode: %s / %s', async (a, b) => {
    const send = (cityCode: string) =>
      answer('GET', `/search/doctors?${new URLSearchParams({ cityCode }).toString()}`);
    expect(await send(a)).toEqual(await send(b));
  });
});
