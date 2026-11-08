import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { trustProxySetting } from '../../src/configure-app';
import { webOriginsFromEnv } from '../../src/modules/identity/web-origins';
import { deviceIdOf, hasMalformedDeviceHeader } from '../../src/modules/identity/web';

describe('TRUST_PROXY', () => {
  it('passes a hop count to Express as a number, anything else as it is', () => {
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting(' 2 ')).toBe(2);
    expect(trustProxySetting('loopback')).toBe('loopback');
    expect(trustProxySetting('10.0.0.0/8, 127.0.0.1')).toBe('10.0.0.0/8, 127.0.0.1');
  });
});

describe('WEB_ORIGINS', () => {
  it('is required, so a missing value fails at start-up and not as 403s later', () => {
    expect(() => webOriginsFromEnv({})).toThrow('WEB_ORIGINS is not set');
    expect(() => webOriginsFromEnv({ WEB_ORIGINS: ' , ' })).toThrow('WEB_ORIGINS is not set');
  });

  it('accepts bare origins only, and never echoes the value', () => {
    expect(
      webOriginsFromEnv({ WEB_ORIGINS: 'https://a.example.ir, http://localhost:3001' }),
    ).toEqual(['https://a.example.ir', 'http://localhost:3001']);
    for (const bad of ['https://a.example.ir/', 'a.example.ir', 'ftp://a.example.ir', 'secret-x']) {
      expect(() => webOriginsFromEnv({ WEB_ORIGINS: bad })).toThrow(
        /^WEB_ORIGINS must list origins/,
      );
      expect(() => webOriginsFromEnv({ WEB_ORIGINS: bad })).not.toThrow(bad);
    }
  });
});

describe('device id', () => {
  const valid = 'a'.repeat(32);
  const request = (header: string | undefined, cookie: string | undefined) =>
    ({
      headers: header === undefined ? {} : { 'x-device-id': header },
      cookies: cookie === undefined ? {} : { '__Host-did': cookie },
    }) as unknown as Request;

  it('falls back to the cookie when the header is malformed', () => {
    expect(deviceIdOf(request('bad id!', valid))).toBe(valid);
    expect(hasMalformedDeviceHeader(request('bad id!', valid))).toBe(true);
  });

  it('prefers a valid header, and ignores malformed values altogether', () => {
    expect(deviceIdOf(request(valid, 'b'.repeat(32)))).toBe(valid);
    expect(deviceIdOf(request('bad', 'also bad'))).toBeNull();
    expect(hasMalformedDeviceHeader(request(undefined, valid))).toBe(false);
  });
});
