/**
 * Where two JSON values differ, leaf by leaf: what the editors of the credit rules and plans
 * show before a proposal is sent (owner 1405/08/10). Arrays are compared position by position;
 * a longer or shorter array is one change at that array.
 */
export type DiffPath = readonly (string | number)[];

export interface Change {
  readonly path: DiffPath;
  readonly before: unknown;
  readonly after: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function diffJson(before: unknown, after: unknown, path: DiffPath = []): Change[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [{ path, before, after }];
    return before.flatMap((b, i) => diffJson(b, after[i], [...path, i]));
  }
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => diffJson(before[k], after[k], [...path, k]));
  }
  return Object.is(before, after) ? [] : [{ path, before, after }];
}

/** The same JSON text, key order included: what the API stores for an unchanged value. */
export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
