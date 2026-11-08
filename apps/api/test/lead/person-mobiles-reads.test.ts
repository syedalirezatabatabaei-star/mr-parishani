import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Task 9-3 (go-live blocker م۵; owner 1405/07/19): every read of person_mobiles goes through
 * one module, person-mobiles.ts, whose reads leave a pending mobile out (but for the few named
 * there that only refuse or restrict). Nothing else names the table, in Drizzle or in SQL, and
 * only the lead module imports that door: other modules ask LEAD_CASES or PERSON_DIRECTORY.
 */

const SRC = join(__dirname, '../../src');
const DOOR = ['modules', 'lead', 'person-mobiles.ts'].join(sep);
const SCHEMA = ['modules', 'lead', 'lead.schema.ts'].join(sep);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

const sources = files(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

describe('person_mobiles is read through person-mobiles.ts only', () => {
  it('no other file names the table (Drizzle or SQL)', () => {
    const naming = sources
      .filter((f) => /\bpersonMobiles\b|\bperson_mobiles\b/.test(f.text))
      .map((f) => f.path);
    expect(naming.sort()).toEqual([DOOR, SCHEMA].sort());
  });

  it('only the lead module opens that door', () => {
    const importing = sources
      .filter((f) => /from '\.{1,2}\/[^']*person-mobiles'/.test(f.text))
      .map((f) => f.path);
    expect(importing.length).toBeGreaterThan(0);
    for (const path of importing) expect(path.startsWith(['modules', 'lead'].join(sep))).toBe(true);
  });

  it('the door leaves pending out of every read but those that only refuse or restrict', () => {
    const door = sources.find((f) => f.path === DOOR)?.text ?? '';
    // Each exported read, and whether it may see a pending mobile.
    const reads = [...door.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
    const seesPending = new Set([
      'holder',
      'countKnown',
      'pendingOf',
      'pendingAll',
      'lockPending',
      'lockOverdue',
      'lockPendingOfBatch',
    ]);
    const writes = new Set([
      'add',
      'markProved',
      'approve',
      'reject',
      'reissuePending',
      'retireOfPerson',
      // f12 (owner 1405/07/26): a mobile its holder replaced, soft-deleted; an UPDATE, no read.
      'retire',
    ]);
    for (const name of reads) {
      if (!name || writes.has(name) || seesPending.has(name)) continue;
      const body = door.slice(door.indexOf(`async ${name}(`)).split(/\n {2}\},?\n/)[0] ?? '';
      expect(body, name).toMatch(/\bactive\b/);
    }
    expect(reads).toEqual(
      expect.arrayContaining([
        'activeOf',
        'firstActive',
        'provedOf',
        'personOfActive',
        'activeByIds',
      ]),
    );
  });
});
