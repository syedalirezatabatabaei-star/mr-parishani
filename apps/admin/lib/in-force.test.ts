import type { ConfigVersionViewBody } from '@sepehr/contracts';
import { describe, expect, it } from 'vitest';
import { inForce } from './in-force';

const version = (id: string, over: Partial<ConfigVersionViewBody>): ConfigVersionViewBody => ({
  id,
  key: 'credit.plans',
  scopeLevel: 'global',
  scopeRef: null,
  value: null,
  effectiveAt: null,
  status: 'approved',
  reason: id,
  proposedBy: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const NOW = Date.parse('2026-11-01T12:00:00Z');

describe('the value in force, as the API resolves it', () => {
  it('is the approved version that started last, not the one created last', () => {
    // The demo: plans seeded in the past, the migration's empty value created after them.
    const migration = version('migration', {
      effectiveAt: '2020-01-01T00:00:00Z',
      createdAt: '2026-10-31T09:00:00Z',
    });
    const plans = version('plans', {
      effectiveAt: '2026-05-01T05:30:00Z',
      createdAt: '2026-05-01T05:30:00Z',
    });
    expect(inForce([migration, plans], NOW)?.id).toBe('plans');
  });

  it('leaves out proposals, refusals, other levels and versions that start later', () => {
    const now = version('now', { effectiveAt: '2026-10-01T00:00:00Z' });
    const versions = [
      version('proposed', { status: 'proposed', effectiveAt: '2026-10-30T00:00:00Z' }),
      version('rejected', { status: 'rejected', effectiveAt: '2026-10-30T00:00:00Z' }),
      version('center', { scopeLevel: 'center', effectiveAt: '2026-10-30T00:00:00Z' }),
      version('later', { effectiveAt: '2026-12-01T00:00:00Z' }),
      now,
    ];
    expect(inForce(versions, NOW)?.id).toBe('now');
  });

  it('breaks a tie of the same start by the later decision', () => {
    const at = '2026-10-01T00:00:00Z';
    const first = version('first', { effectiveAt: at, decidedAt: '2026-10-01T00:00:00Z' });
    const second = version('second', { effectiveAt: at, decidedAt: '2026-10-02T00:00:00Z' });
    expect(inForce([first, second], NOW)?.id).toBe('second');
    expect(inForce([], NOW)).toBeUndefined();
  });
});
