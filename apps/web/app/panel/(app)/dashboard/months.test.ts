import { showJalaliMonth } from '@sepehr/ui';
import { describe, expect, it } from 'vitest';
import { byMonth, monthOfInstant } from './months';

describe('panel dashboard months', () => {
  it("a statement's Jalali period is its month as it is (was year 783)", () => {
    const rows = [
      { periodYear: 1405, periodMonth: 7, grossRial: '300' },
      { periodYear: 1405, periodMonth: 3, grossRial: '100' },
      { periodYear: 1405, periodMonth: 7, grossRial: '50' },
      { periodYear: 1404, periodMonth: 12, grossRial: '7' },
    ];
    const sums = byMonth(
      rows,
      (s) => ({ year: s.periodYear, month: s.periodMonth }),
      (s) => s.grossRial,
    );
    expect(sums).toEqual([
      { label: showJalaliMonth(1404, 12), rial: 7n },
      { label: showJalaliMonth(1405, 3), rial: 100n },
      { label: showJalaliMonth(1405, 7), rial: 350n },
    ]);
  });

  it("an instant falls in Tehran's Jalali month", () => {
    // 2026-10-22T20:31Z is 1405/08/01 00:01 in Tehran; a minute before is still Mehr.
    expect(monthOfInstant('2026-10-22T20:31:00Z')).toMatchObject({ year: 1405, month: 8 });
    expect(monthOfInstant('2026-10-22T20:29:00Z')).toMatchObject({ year: 1405, month: 7 });
  });
});
