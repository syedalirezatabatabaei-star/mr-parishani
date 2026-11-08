import type { ConfigVersionViewBody } from '@sepehr/contracts';

const startOf = (v: ConfigVersionViewBody) =>
  Date.parse(v.effectiveAt ?? v.decidedAt ?? v.createdAt);

/**
 * The global value in force at `now`, as the API resolves it (config.service.ts): of the
 * approved versions already started, the one that started last, then the one decided last.
 * Not the first in the list: the list is by creation, and a version can be created after
 * one that starts later (a seed in the past, a day chosen ahead; owner 1405/08/10).
 */
export function inForce(
  versions: readonly ConfigVersionViewBody[],
  now = Date.now(),
): ConfigVersionViewBody | undefined {
  return versions
    .filter((v) => v.status === 'approved' && v.scopeLevel === 'global' && startOf(v) <= now)
    .sort(
      (a, b) =>
        startOf(b) - startOf(a) ||
        Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt) ||
        b.id.localeCompare(a.id),
    )[0];
}
