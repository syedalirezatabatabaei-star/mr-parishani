import { describe, expect, it } from 'vitest';
import type { EffectiveAccess, ResolvedScope } from '../../src/common/auth/access.port';
import { capByDoctor, rlsSettingsOf, scopeWithin } from '../../src/modules/access/scope';

const node = (kind: 'center' | 'doctor', path: string, cityCode = 'tehran'): ResolvedScope => ({
  kind,
  nodeId: path,
  path,
  cityCode,
});

const access = (permissions: string[], scopes: ResolvedScope[]): EffectiveAccess => ({
  accountId: 'x',
  roles: [],
  permissions: new Set(permissions) as EffectiveAccess['permissions'],
  scopes,
});

describe('scopeWithin', () => {
  it('nests nodes by path, never by a shared prefix of labels', () => {
    expect(scopeWithin(node('doctor', 'c1.d1'), node('center', 'c1'))).toBe(true);
    expect(scopeWithin(node('doctor', 'c1.d1.s1'), node('doctor', 'c1.d1'))).toBe(true);
    expect(scopeWithin(node('doctor', 'c1.d2'), node('doctor', 'c1.d1'))).toBe(false);
    expect(scopeWithin(node('doctor', 'c10.d1'), node('center', 'c1'))).toBe(false);
    expect(scopeWithin(node('center', 'c1'), node('doctor', 'c1.d1'))).toBe(false);
  });

  it('puts nodes inside their city, and everything inside global', () => {
    expect(scopeWithin(node('center', 'c1', 'tehran'), { kind: 'city', code: 'tehran' })).toBe(
      true,
    );
    expect(scopeWithin(node('center', 'c1', 'shiraz'), { kind: 'city', code: 'tehran' })).toBe(
      false,
    );
    expect(scopeWithin({ kind: 'global' }, { kind: 'global' })).toBe(true);
    expect(scopeWithin({ kind: 'global' }, node('center', 'c1'))).toBe(false);
    expect(
      scopeWithin({ kind: 'queue', code: 'collection' }, { kind: 'queue', code: 'credit' }),
    ).toBe(false);
  });
});

describe('capByDoctor — a secretary never exceeds their doctor (doc 04 §2)', () => {
  const doctor = access(['access.read_org', 'access.view_treatment'], [node('doctor', 'c1.d1')]);

  it('keeps only permissions the doctor holds', () => {
    const secretary = access(['access.read_org', 'audit.read'], [node('doctor', 'c1.d1')]);
    expect([...capByDoctor(secretary, doctor).permissions]).toEqual(['access.read_org']);
  });

  it('keeps only scopes inside the doctor’s', () => {
    const secretary = access(
      ['access.read_org'],
      [
        { kind: 'global' },
        { kind: 'city', code: 'tehran' },
        node('center', 'c1'),
        node('doctor', 'c1.d1'),
      ],
    );
    expect(capByDoctor(secretary, doctor).scopes).toEqual([node('doctor', 'c1.d1')]);
  });

  it('leaves nothing when the doctor has nothing', () => {
    const secretary = access(['access.read_org'], [{ kind: 'global' }]);
    const capped = capByDoctor(secretary, access([], []));
    expect(capped.permissions.size).toBe(0);
    expect(capped.scopes).toEqual([]);
  });
});

describe('rlsSettingsOf', () => {
  it('turns scopes into the settings the row-level security policy reads', () => {
    expect(
      rlsSettingsOf(
        access(
          [],
          [node('doctor', 'c1.d1'), node('center', 'c2'), { kind: 'city', code: 'tabriz' }],
        ),
      ),
    ).toEqual({ all: false, paths: 'c1.d1,c2', cities: 'tabriz' });
    expect(rlsSettingsOf(access([], [{ kind: 'global' }])).all).toBe(true);
    expect(rlsSettingsOf(access([], []))).toEqual({ all: false, paths: '', cities: '' });
  });
});
