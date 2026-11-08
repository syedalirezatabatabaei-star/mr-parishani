import { toJalali } from '@sepehr/contracts';
import { showJalaliMonth } from '@sepehr/ui';

/** A Jalali month, as the dashboard groups by it. */
export interface JalaliMonth {
  year: number;
  month: number;
}

/** An instant's Tehran month (Jalali). */
export const monthOfInstant = (at: string): JalaliMonth => toJalali(new Date(at));

/**
 * Sums by Jalali month, oldest first. A statement's period is a Jalali year and month already
 * (doc 06), so it is taken as it is, never through a Date: read as a Gregorian date, 1405 was
 * the Jalali year 783 and the page failed (1405/08/09).
 */
export function byMonth<T>(
  rows: readonly T[],
  month: (r: T) => JalaliMonth,
  rial: (r: T) => string,
) {
  const sums = new Map<string, { label: string; rial: bigint }>();
  for (const r of rows) {
    const m = month(r);
    const key = `${String(m.year)}-${String(m.month).padStart(2, '0')}`;
    const prev = sums.get(key);
    sums.set(key, {
      label: showJalaliMonth(m.year, m.month),
      rial: (prev?.rial ?? 0n) + BigInt(rial(r)),
    });
  }
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}
