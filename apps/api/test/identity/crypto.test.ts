import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/modules/identity/password';
import { hashToken, keyedHash, newToken, safeEqual } from '../../src/modules/identity/tokens';
import { FieldCrypto } from '../../src/security/field-crypto';

describe('FieldCrypto', () => {
  const crypto = new FieldCrypto(randomBytes(32));

  it('round-trips a value', () => {
    const stored = crypto.encrypt('JBSWY3DPEHPK3PXP', 'ctx');
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(crypto.decrypt(stored, 'ctx')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV each time', () => {
    expect(crypto.encrypt('same', 'ctx')).not.toBe(crypto.encrypt('same', 'ctx'));
  });

  it('refuses a value moved to another context (column or row)', () => {
    const stored = crypto.encrypt('secret', 'user_accounts.totp:a');
    expect(() => crypto.decrypt(stored, 'user_accounts.totp:b')).toThrow();
  });

  it('refuses a tampered value or the wrong key', () => {
    const stored = crypto.encrypt('secret', 'ctx');
    const parts = stored.split('.');
    const ciphertext = Buffer.from(parts[2] ?? '', 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    parts[2] = ciphertext.toString('base64url');
    expect(() => crypto.decrypt(parts.join('.'), 'ctx')).toThrow();
    expect(() => new FieldCrypto(randomBytes(32)).decrypt(stored, 'ctx')).toThrow();
  });

  it('refuses a shortened authentication tag', () => {
    const [version, iv, ciphertext, tag] = crypto.encrypt('secret', 'ctx').split('.');
    const short = Buffer.from(tag ?? '', 'base64url')
      .subarray(0, 4)
      .toString('base64url');
    expect(() => crypto.decrypt([version, iv, ciphertext, short].join('.'), 'ctx')).toThrow();
  });

  it('needs a 32-byte key', () => {
    expect(() => new FieldCrypto(randomBytes(16))).toThrow('32-byte');
  });
});

describe('tokens', () => {
  it('are 256-bit, unique, and stored only as a hash', () => {
    const token = newToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newToken()).not.toBe(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('keyed hashes differ by label, so an OTP hash never passes as a CSRF token', () => {
    const key = randomBytes(32);
    expect(keyedHash(key, 'otp', 'x')).not.toBe(keyedHash(key, 'csrf', 'x'));
    expect(keyedHash(key, 'otp', 'x')).not.toBe(keyedHash(randomBytes(32), 'otp', 'x'));
  });

  it('safeEqual compares exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('argon2id passwords', () => {
  it('hash with argon2id and verify', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('treat a malformed hash as a failed login, not an error', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
