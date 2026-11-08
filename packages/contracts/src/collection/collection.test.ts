import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  collectionBucketsSchema,
  escalationRulesSchema,
  stagesReached,
  type EscalationRules,
} from './index.js';

const RULES: EscalationRules = {
  stage1: { minDays: 1 },
  stage2: { minDays: 30, minInstallments: 2 },
  stage3: { minDays: 60, minInstallments: 3 },
};

describe('collection rules (task 6-7)', () => {
  it('buckets by their first day: 1-30, 31-60, 61-90, 91+', () => {
    const b = [1, 31, 61, 91];
    expect(bucketOf(0, b)).toBeNull();
    expect(bucketOf(1, b)).toEqual({ index: 0, from: 1, to: 30 });
    expect(bucketOf(30, b)).toEqual({ index: 0, from: 1, to: 30 });
    expect(bucketOf(31, b)).toEqual({ index: 1, from: 31, to: 60 });
    expect(bucketOf(400, b)).toEqual({ index: 3, from: 91, to: null });
    expect(collectionBucketsSchema.safeParse([1, 31, 31]).success).toBe(false);
  });

  it('stages by days or overdue installments, whichever first (doc 15 §5)', () => {
    expect(stagesReached(0, 0, RULES)).toEqual([]);
    expect(stagesReached(1, 1, RULES)).toEqual([1]);
    expect(stagesReached(12, 2, RULES)).toEqual([1, 2]);
    expect(stagesReached(30, 1, RULES)).toEqual([1, 2]);
    expect(stagesReached(45, 3, RULES)).toEqual([1, 2, 3]);
    expect(stagesReached(60, 1, RULES)).toEqual([1, 2, 3]);
    expect(
      stagesReached(29, 5, { ...RULES, stage2: { minDays: 30 }, stage3: { minDays: 60 } }),
    ).toEqual([1]);
    expect(escalationRulesSchema.safeParse({ stage1: { minDays: 0 } }).success).toBe(false);
  });
});
