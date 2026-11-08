import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hotp,
  newTotpSecret,
  totpStep,
  totpUri,
  verifyTotp,
} from '../../src/modules/identity/totp';

// The shared secret of RFC 4226 appendix D and RFC 6238 appendix B.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('base32 (RFC 4648 §10, without padding)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('%j ↔ %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
    expect(base32Decode(encoded).toString('ascii')).toBe(plain);
  });

  it('accepts padding and lowercase, rejects other characters', () => {
    expect(base32Decode('mzxw6ytboi======').toString('ascii')).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow('Invalid base32');
  });
});

describe('HOTP (RFC 4226 appendix D)', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  it.each(expected.map((code, counter) => [counter, code]))('counter %i → %s', (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe('TOTP (RFC 6238 appendix B, SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T = %i → %s', (seconds, code) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
  });
});

describe('verifyTotp', () => {
  const secret = base32Encode(RFC_SECRET);
  const now = 1_234_567_890_000;
  const step = totpStep(now);
  const codeAt = (s: number) => hotp(RFC_SECRET, s);

  it('accepts the current code and returns its step', () => {
    expect(verifyTotp(secret, codeAt(step), now)).toBe(step);
  });

  it('allows one step of clock drift either way, not two', () => {
    expect(verifyTotp(secret, codeAt(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, codeAt(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, codeAt(step - 2), now)).toBeNull();
    expect(verifyTotp(secret, codeAt(step + 2), now)).toBeNull();
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
});

describe('secrets and URIs', () => {
  it('makes 160-bit secrets', () => {
    const secret = newTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(secret);
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    const uri = new URL(totpUri('JBSWY3DPEHPK3PXP', 'ali', 'Sepehr Salamati'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Sepehr Salamati:ali');
    expect(uri.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});
