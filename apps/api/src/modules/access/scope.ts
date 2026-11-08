import type { PermissionCode } from '@sepehr/contracts';
import type { EffectiveAccess, ResolvedScope } from '../../common/auth/access.port';

/** Whether `scope` lies entirely within `by`. */
export function scopeWithin(scope: ResolvedScope, by: ResolvedScope): boolean {
  if (by.kind === 'global') return true;
  switch (scope.kind) {
    case 'global':
      return false;
    case 'own':
      // The user's own records: nothing beyond what any other scope already allows.
      return true;
    case 'city':
      return by.kind === 'city' && by.code === scope.code;
    case 'queue':
      return by.kind === 'queue' && by.code === scope.code;
    case 'center':
    case 'branch':
    case 'doctor':
      if (by.kind === 'city') return scope.cityCode === by.code;
      if (by.kind === 'center' || by.kind === 'branch' || by.kind === 'doctor') {
        return scope.path === by.path || scope.path.startsWith(`${by.path}.`);
      }
      return false;
  }
}

/**
 * The hard rule of doc 04 §2, locked in code: a secretary never has more than their
 * doctor. Permissions are the intersection with the doctor's; a scope survives only if
 * it lies within one of the doctor's scopes.
 */
export function capByDoctor(secretary: EffectiveAccess, doctor: EffectiveAccess): EffectiveAccess {
  const permissions = new Set<PermissionCode>(
    [...secretary.permissions].filter((code) => doctor.permissions.has(code)),
  );
  const scopes = secretary.scopes.filter((scope) =>
    doctor.scopes.some((by) => scopeWithin(scope, by)),
  );
  return { ...secretary, permissions, scopes };
}

/** The settings row-level security reads (migration 0002), for one transaction. */
export interface RlsSettings {
  readonly all: boolean;
  readonly paths: string;
  readonly cities: string;
}

export function rlsSettingsOf(access: EffectiveAccess): RlsSettings {
  const paths: string[] = [];
  const cities: string[] = [];
  let all = false;
  for (const scope of access.scopes) {
    if (scope.kind === 'global') all = true;
    else if (scope.kind === 'city') cities.push(scope.code);
    else if (scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') {
      paths.push(scope.path);
    }
  }
  return { all, paths: paths.join(','), cities: cities.join(',') };
}
