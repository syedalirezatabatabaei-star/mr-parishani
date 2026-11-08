import { compareJalali, jalaliMonthLength } from '@sepehr/contracts';
import { describe, expect, it } from 'vitest';
import { monthGrid } from './model.js';

describe('monthGrid', () => {
  it('is always six weeks from Saturday, holding the whole month in order', () => {
    for (const [year, month] of [
      [1405, 7],
      [1405, 12],
      [1403, 12],
      [1404, 1],
      [1406, 6],
    ] as const) {
      const weeks = monthGrid(year, month);
      expect(weeks).toHaveLength(6);
      const days = weeks.flat();
      expect(days.every((c, i) => c.weekday === weeks[0]?.[i % 7]?.weekday)).toBe(true);
      expect(weeks[0]?.[0]?.weekday).toBe('saturday');
      expect(days.filter((c) => c.inMonth)).toHaveLength(jalaliMonthLength(year, month));
      days.slice(1).forEach((c, i) => {
        const before = days[i];
        if (before) expect(compareJalali(before.date, c.date)).toBeLessThan(0);
      });
    }
  });
});
