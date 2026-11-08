import { describe, expect, it } from 'vitest';
import {
  parseRebuildArgs,
  REBUILD_USAGE,
  refreshDueAt,
} from '../../src/modules/catalog/search-index';
import { loggableTerm } from '../../src/modules/catalog/search.service';

describe('catalog:rebuild-search command line (task 2-7 decision 1)', () => {
  it('is a dry run unless --apply is given; pnpm’s lone -- is skipped', () => {
    expect(parseRebuildArgs([])).toBe('dry_run');
    expect(parseRebuildArgs(['--dry-run'])).toBe('dry_run');
    expect(parseRebuildArgs(['--', '--apply'])).toBe('apply');
  });

  it('refuses anything unknown, and both modes at once', () => {
    expect(() => parseRebuildArgs(['--force'])).toThrow(REBUILD_USAGE);
    expect(() => parseRebuildArgs(['--apply', '--dry-run'])).toThrow(REBUILD_USAGE);
  });
});

describe('refreshDueAt', () => {
  const now = new Date('2026-10-01T06:00:00Z');

  it('is when the indexed free time passes, if that comes before the entry grows old', () => {
    const soon = new Date('2026-10-01T06:30:00Z');
    expect(refreshDueAt(soon, now, 60)).toEqual(soon);
  });

  it('is the maximum age otherwise, also for an entry with no free time', () => {
    const later = new Date('2026-10-03T06:00:00Z');
    const oldest = new Date('2026-10-01T07:00:00Z');
    expect(refreshDueAt(later, now, 60)).toEqual(oldest);
    expect(refreshDueAt(null, now, 60)).toEqual(oldest);
  });
});

describe('loggableTerm (rule 30)', () => {
  it('keeps the phrase but never a mobile or a national ID', () => {
    expect(loggableTerm('09121234567 علی')).toBe('# علی');
    expect(loggableTerm('0012345678')).toBe('#');
    expect(loggableTerm('کلینیک 1405')).toBe('کلینیک 1405');
    expect(loggableTerm('x'.repeat(300))).toHaveLength(100);
  });
});
