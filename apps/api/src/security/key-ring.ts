import { secretKeyFromEnv } from '../infra/env';

/**
 * The keys of one secret (R4, task 9-3): key 1 is the original variable (`FIELD_ENCRYPTION_KEY`,
 * `BLIND_INDEX_KEY`) and keeps meaning what it always meant; a new key is added as `<NAME>_2`,
 * `<NAME>_3`…, and `<NAME>_ACTIVE` names the one that writes (1 by default). Every key reads,
 * so values written under an older key stay readable until re-encrypted.
 */
export interface KeyRing {
  readonly active: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

const MAX_KEY_ID = 99;

export const singleKey = (key: Buffer): KeyRing => ({ active: 1, keys: new Map([[1, key]]) });

/** The stored prefix of a key: `v1` for key 1 (the form before rotation), `k<N>` after. */
export const keyPrefix = (id: number) => (id === 1 ? 'v1' : `k${String(id)}`);

/** The key id a stored value names, or null for a form this code does not know. */
export function keyIdOf(stored: string): number | null {
  const prefix = stored.slice(0, stored.indexOf('.'));
  if (prefix === 'v1') return 1;
  const match = /^k([2-9]|[1-9]\d)$/.exec(prefix);
  return match ? Number(match[1]) : null;
}

export function keyRingFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): KeyRing {
  const keys = new Map<number, Buffer>([[1, secretKeyFromEnv(name, env)]]);
  for (let id = 2; id <= MAX_KEY_ID; id++) {
    if ((env[`${name}_${String(id)}`] ?? '') !== '') {
      keys.set(id, secretKeyFromEnv(`${name}_${String(id)}`, env));
    }
  }
  const raw = env[`${name}_ACTIVE`] ?? '1';
  const active = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!keys.has(active)) throw new Error(`${name}_ACTIVE names no configured key`);
  const seen = new Set<string>();
  for (const key of keys.values()) {
    const hex = key.toString('hex');
    if (seen.has(hex)) throw new Error(`${name}: two key ids hold the same key`);
    seen.add(hex);
  }
  return { active, keys };
}
