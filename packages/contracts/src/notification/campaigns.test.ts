import { describe, expect, it } from 'vitest';
import { CAMPAIGN_FILTERS, jalaliMomentToDate, scheduleSmsSchema } from './campaigns.js';

describe('campaigns (task 6-5)', () => {
  it('a Jalali moment is Tehran wall time (UTC+03:30)', () => {
    // 1405/07/20 10:30 Tehran = 2026-10-12 07:00 UTC.
    expect(jalaliMomentToDate({ date: '1405/07/20', time: '10:30' }).toISOString()).toBe(
      '2026-10-12T07:00:00.000Z',
    );
    expect(jalaliMomentToDate({ date: '۱۴۰۵/۰۷/۲۰', time: '10:30' }).toISOString()).toBe(
      '2026-10-12T07:00:00.000Z',
    );
  });

  it('each filter takes only its own parameters; a scheduled SMS names a person or a mobile', () => {
    expect(CAMPAIGN_FILTERS.borrowers_overdue_at_least.params.safeParse({ days: 30 }).success).toBe(
      true,
    );
    expect(CAMPAIGN_FILTERS.borrowers_overdue_at_least.params.safeParse({}).success).toBe(false);
    expect(CAMPAIGN_FILTERS.borrowers_active.params.safeParse({ days: 1 }).success).toBe(false);
    expect(CAMPAIGN_FILTERS.patients_of_center.params.safeParse({ workplaceIds: [] }).success).toBe(
      false,
    );
    const base = {
      templateCode: 'a.b',
      sendAt: { date: '1405/07/20', time: '10:30' },
      reason: 'آزمون',
    };
    expect(scheduleSmsSchema.safeParse(base).success).toBe(false);
    expect(scheduleSmsSchema.safeParse({ ...base, mobile: '09121234567' }).success).toBe(true);
    expect(
      scheduleSmsSchema.safeParse({ ...base, mobile: '09121234567', personId: crypto.randomUUID() })
        .success,
    ).toBe(false);
  });
});
