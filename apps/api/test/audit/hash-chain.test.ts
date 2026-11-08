import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  chainHash,
  GENESIS_HASH,
  type ChainedFields,
} from '../../src/modules/audit/hash-chain';

describe('canonicalJson', () => {
  it('is independent of key order, at any depth, as after a jsonb round trip', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('drops undefined properties like JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses a JS bigint: money goes in as a string', () => {
    expect(() => canonicalJson({ amountRial: 10n })).toThrow('bigint');
  });
});

describe('chainHash', () => {
  const fields: ChainedFields = {
    seq: '1',
    id: '01a0e1e7-1068-7b59-9123-1f35163ca052',
    createdAt: '2026-09-27T08:00:00.000Z',
    actorAccountId: null,
    actorSessionId: null,
    actorIp: null,
    actorRoles: ['cli'],
    action: 'access.role_assigned',
    entityType: 'user_account',
    entityId: 'u1',
    before: null,
    after: { role: 'auditor' },
    reason: 'test',
    prevHash: GENESIS_HASH,
  };

  it('is a SHA-256 hex digest', () => {
    expect(chainHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with any field, the previous hash included', () => {
    const base = chainHash(fields);
    expect(chainHash({ ...fields, reason: 'Test' })).not.toBe(base);
    expect(chainHash({ ...fields, after: { role: 'doctor' } })).not.toBe(base);
    expect(chainHash({ ...fields, prevHash: 'f'.repeat(64) })).not.toBe(base);
    expect(chainHash({ ...fields })).toBe(base);
  });
});
