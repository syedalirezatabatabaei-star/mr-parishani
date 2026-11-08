import { describe, expect, it } from 'vitest';
import { BATCH_STATUS, ROW_STATUS, totals } from './imports';

describe('import labels and totals', () => {
  it('counts every row, and as not imported the duplicates, errors and failures', () => {
    expect(
      totals({
        centers: { valid: 3, duplicate: 1, error: 2 },
        doctors: { created: 5, failed: 1 },
      }),
    ).toEqual({ all: 12, rejected: 4 });
    expect(totals({})).toEqual({ all: 0, rejected: 0 });
  });

  it('every batch and row status has a Persian label', () => {
    for (const { label } of Object.values(BATCH_STATUS)) expect(label).toMatch(/[آ-ی]/);
    for (const label of Object.values(ROW_STATUS)) expect(label).toMatch(/[آ-ی]/);
  });
});
