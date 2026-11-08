import { describe, expect, it } from 'vitest';
import { parseBackfillArgs, planBackfill } from '../../src/modules/identity/person-backfill';

describe('parseBackfillArgs', () => {
  it('is a dry run unless --apply; skips the -- pnpm passes through', () => {
    expect(parseBackfillArgs([])).toBe('dry_run');
    expect(parseBackfillArgs(['--dry-run'])).toBe('dry_run');
    expect(parseBackfillArgs(['--', '--dry-run'])).toBe('dry_run');
    expect(parseBackfillArgs(['--apply'])).toBe('apply');
    expect(parseBackfillArgs(['--', '--apply'])).toBe('apply');
    expect(parseBackfillArgs(['--'])).toBe('dry_run');
  });

  it('refuses anything unknown, and both modes at once', () => {
    for (const args of [
      ['--aply'],
      ['--', '--aply'],
      ['apply'],
      ['--apply', '--force'],
      ['--apply', '--dry-run'],
      ['--', '--apply', '--', '--dry-run'],
    ]) {
      expect(() => parseBackfillArgs(args)).toThrow(/usage/);
    }
  });
});

describe('planBackfill (task 2-5b decision 1)', () => {
  it('links clean accounts; shared or invalid mobiles go to manual review, never merged', () => {
    const plan = planBackfill([
      { id: 'linked', mobile: '9120000001', personId: 'p1' },
      { id: 'clean', mobile: '9120000002', personId: null },
      { id: 'shared-a', mobile: '9120000003', personId: null },
      { id: 'shared-b', mobile: '09120000003', personId: null },
      // Shares with an account already linked: still a person's call.
      { id: 'shared-linked', mobile: '+98 912 000 0001', personId: null },
      { id: 'invalid', mobile: '12345', personId: null },
      { id: 'none', mobile: null, personId: null },
    ]);
    expect(plan.candidates.map((c) => c.id)).toEqual([
      'clean',
      'shared-a',
      'shared-b',
      'shared-linked',
      'invalid',
      'none',
    ]);
    expect(plan.fillable).toEqual([{ id: 'clean', mobile: '9120000002' }]);
    expect(plan.manualReview).toEqual([
      { accountId: 'shared-a', reason: 'shared_mobile' },
      { accountId: 'shared-b', reason: 'shared_mobile' },
      { accountId: 'shared-linked', reason: 'shared_mobile' },
      { accountId: 'invalid', reason: 'invalid_mobile' },
      { accountId: 'none', reason: 'invalid_mobile' },
    ]);
  });
});
