import { createHash } from 'node:crypto';

/** prev_hash of the very first event. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * JSON with object keys sorted at every depth and `undefined` properties dropped, so the
 * same value always gives the same text: before hashing, and again after a round trip
 * through jsonb, which reorders keys. JS bigints are refused: money goes in as strings.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') throw new TypeError('bigint in an audit event; use a string');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

/** The fields of an audit row that its hash covers. */
export interface ChainedFields {
  readonly seq: string;
  readonly id: string;
  readonly createdAt: string;
  readonly actorAccountId: string | null;
  readonly actorSessionId: string | null;
  readonly actorIp: string | null;
  readonly actorRoles: readonly string[];
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  /**
   * Task 2-3. Left out of the hash while empty, so the rows written before the column
   * existed keep their hashes.
   */
  readonly onBehalfOfDoctorId?: string | undefined;
  readonly prevHash: string;
}

/** SHA-256 over the canonical form of the row, previous hash included. */
export function chainHash(fields: ChainedFields): string {
  return createHash('sha256').update(canonicalJson(fields), 'utf8').digest('hex');
}
