import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlindIndex } from './blind-index';
import { FieldCrypto } from './field-crypto';
import { keyIdOf, keyRingFromEnv } from './key-ring';

const b64 = () => randomBytes(32).toString('base64');

describe('key rings (R4, task 9-3)', () => {
  it('without new variables, key 1 alone: the stored forms are those before rotation', () => {
    const env = { FIELD_ENCRYPTION_KEY: b64() };
    const ring = keyRingFromEnv('FIELD_ENCRYPTION_KEY', env);
    expect(ring.active).toBe(1);
    expect([...ring.keys.keys()]).toEqual([1]);
    const crypto = new FieldCrypto(ring);
    const stored = crypto.encrypt('0012345678', 'ctx');
    expect(stored).toMatch(/^v1\./);
    // The same key as a plain Buffer reads it: nothing written before changes.
    expect(new FieldCrypto(ring.keys.get(1) as Buffer).decrypt(stored, 'ctx')).toBe('0012345678');
  });

  it('a new active key writes k<N>; every key still reads', () => {
    const env = { FIELD_ENCRYPTION_KEY: b64(), FIELD_ENCRYPTION_KEY_2: b64() };
    const old = new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY', env));
    const before = old.encrypt('secret', 'ctx');
    const ring = keyRingFromEnv('FIELD_ENCRYPTION_KEY', {
      ...env,
      FIELD_ENCRYPTION_KEY_ACTIVE: '2',
    });
    const now = new FieldCrypto(ring);
    const after = now.encrypt('secret', 'ctx');
    expect(after).toMatch(/^k2\./);
    expect(keyIdOf(after)).toBe(2);
    expect(now.decrypt(before, 'ctx')).toBe('secret');
    expect(now.decrypt(after, 'ctx')).toBe('secret');
    expect(now.isCurrent(before)).toBe(false);
    expect(now.isCurrent(after)).toBe(true);
    // Key 1 alone cannot read what key 2 wrote.
    const keyOne = Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64');
    expect(() => new FieldCrypto(keyOne).decrypt(after, 'ctx')).toThrow('Unrecognized');
  });

  it('refuses an active key that is not configured, or one key under two ids', () => {
    const one = b64();
    expect(() =>
      keyRingFromEnv('BLIND_INDEX_KEY', { BLIND_INDEX_KEY: one, BLIND_INDEX_KEY_ACTIVE: '2' }),
    ).toThrow('_ACTIVE names no configured key');
    expect(() =>
      keyRingFromEnv('BLIND_INDEX_KEY', { BLIND_INDEX_KEY: one, BLIND_INDEX_KEY_ACTIVE: 'x' }),
    ).toThrow('_ACTIVE');
    expect(() =>
      keyRingFromEnv('BLIND_INDEX_KEY', { BLIND_INDEX_KEY: one, BLIND_INDEX_KEY_2: one }),
    ).toThrow('same key');
  });

  it('blind indexes follow the active key, and a new key makes a different index', () => {
    const env = { BLIND_INDEX_KEY: b64(), BLIND_INDEX_KEY_2: b64() };
    const old = new BlindIndex(keyRingFromEnv('BLIND_INDEX_KEY', env));
    const now = new BlindIndex(
      keyRingFromEnv('BLIND_INDEX_KEY', { ...env, BLIND_INDEX_KEY_ACTIVE: '2' }),
    );
    const before = old.of('national_id', '0012345678');
    const after = now.of('national_id', '0012345678');
    expect(before).toMatch(/^v1\./);
    expect(after).toMatch(/^k2\./);
    expect(after).not.toBe(before);
    expect(now.isCurrent(before)).toBe(false);
    expect(now.isCurrent(after)).toBe(true);
  });

  it('finds a value under every key, the active one first, and locks it the same way (ADR-040)', () => {
    const env = { BLIND_INDEX_KEY: b64(), BLIND_INDEX_KEY_2: b64(), BLIND_INDEX_KEY_3: b64() };
    const old = new BlindIndex(keyRingFromEnv('BLIND_INDEX_KEY', env));
    const now = new BlindIndex(
      keyRingFromEnv('BLIND_INDEX_KEY', { ...env, BLIND_INDEX_KEY_ACTIVE: '2' }),
    );
    const all = now.allOf('instrument_number', '1234567890123456');
    expect(all).toHaveLength(3);
    expect(all.map((i) => i.slice(0, i.indexOf('.')))).toEqual(['k2', 'v1', 'k3']);
    expect(all[0]).toBe(now.of('instrument_number', '1234567890123456'));
    // The index written before the rotation is among them.
    expect(all).toContain(old.of('instrument_number', '1234567890123456'));
    // The lock's index is the lowest key's, whichever key writes; another value, another lock.
    expect(now.stableOf('instrument_number', '1234567890123456')).toBe(
      old.stableOf('instrument_number', '1234567890123456'),
    );
    expect(now.stableOf('instrument_number', '1234567890123456')).toMatch(/^v1\./);
    expect(now.stableOf('instrument_number', '1234567890123457')).not.toBe(
      now.stableOf('instrument_number', '1234567890123456'),
    );
    expect(now.activeKeyId).toBe(2);
  });

  it('reads nothing but the known forms', () => {
    expect(keyIdOf('v1.a.b.c')).toBe(1);
    expect(keyIdOf('k12.a.b.c')).toBe(12);
    for (const bad of ['k1.a', 'k0.a', 'v2.a', 'k100.a', 'nodots']) expect(keyIdOf(bad)).toBeNull();
  });
});
