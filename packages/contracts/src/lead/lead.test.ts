import { describe, expect, it } from 'vitest';
import { CASE_FUNNEL_TARGETS, SETTLEABLE_CASE_STATUSES } from './lead.js';

describe('the case funnel and case completion (owner 1405/07/23)', () => {
  it('every stage the funnel brings a case to is one a settled case completes from', () => {
    // Launch checklist item 7: a task that moves a case further widens completion with it,
    // or a settled case would be left with no way to complete.
    for (const target of Object.values(CASE_FUNNEL_TARGETS)) {
      expect(SETTLEABLE_CASE_STATUSES).toContain(target);
    }
  });
});
