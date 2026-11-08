import { describe, expect, it } from 'vitest';
import { installmentState } from './state.js';
import { reminderKey, reminderStep, type ReminderStep } from './reminders.js';

const DUE = '2026-10-20';

/** The step for a day, with nothing paid and the documented offsets (decision 6.3). */
function on(today: string, sent: readonly ReminderStep[] = [], graceDays = 0, paid = 0n) {
  const state = installmentState(DUE, 1_000n, paid, today, graceDays);
  return reminderStep({
    dueOn: DUE,
    today,
    state: state.status,
    daysPastDue: state.daysPastDue,
    daysBefore: [3, 0],
    overdueDays: [1, 7, 15],
    sent: new Set(sent.map(reminderKey)),
  });
}

describe('reminderStep (task 6-6)', () => {
  it('3 and 0 days before, 1, 7 and 15 after; nothing between', () => {
    expect(on('2026-10-16')).toBeNull();
    expect(on('2026-10-17')).toEqual({ kind: 'before_due', offsetDays: 3 });
    expect(on('2026-10-20')).toEqual({ kind: 'before_due', offsetDays: 0 });
    expect(on('2026-10-21')).toEqual({ kind: 'overdue', offsetDays: 1 });
    expect(on('2026-10-27')).toEqual({ kind: 'overdue', offsetDays: 7 });
    expect(on('2026-11-04')).toEqual({ kind: 'overdue', offsetDays: 15 });
  });

  it('a step sent is not sent again; the day after, nothing new', () => {
    const three = { kind: 'before_due', offsetDays: 3 } as const;
    expect(on('2026-10-17', [three])).toBeNull();
    expect(on('2026-10-18', [three])).toBeNull();
    const one = { kind: 'overdue', offsetDays: 1 } as const;
    expect(on('2026-10-22', [one])).toBeNull();
    expect(on('2026-10-28', [one])).toEqual({ kind: 'overdue', offsetDays: 7 });
  });

  it('a paid installment gets nothing, before or after its day', () => {
    expect(on('2026-10-17', [], 0, 1_000n)).toBeNull();
    expect(on('2026-10-21', [], 0, 1_000n)).toBeNull();
    // Partly paid still owes: reminded.
    expect(on('2026-10-17', [], 0, 400n)).toEqual({ kind: 'before_due', offsetDays: 3 });
  });

  it('a missed night caught up only for a few days, and only the latest step', () => {
    expect(on('2026-10-18')).toEqual({ kind: 'before_due', offsetDays: 3 });
    expect(on('2026-10-30')).toEqual({ kind: 'overdue', offsetDays: 7 });
    // Day 12 is 5 days past step 7: too late; nothing until 15.
    expect(on('2026-11-01')).toBeNull();
    // Long overdue (a first run on old debt): no burst.
    expect(on('2027-01-20')).toBeNull();
  });

  it('grace days: overdue notices only once overdue, counted from the due day', () => {
    // Grace 3: day 1 to 3 are still due, not overdue: neither reminder nor notice.
    expect(on('2026-10-21', [], 3)).toBeNull();
    expect(on('2026-10-23', [], 3)).toBeNull();
    // Day 4: overdue; the latest step reached is 1, within the catch-up days.
    expect(on('2026-10-24', [], 3)).toEqual({ kind: 'overdue', offsetDays: 1 });
  });

  it('empty offsets turn a kind off', () => {
    const state = installmentState(DUE, 1_000n, 0n, '2026-10-17', 0);
    expect(
      reminderStep({
        dueOn: DUE,
        today: '2026-10-17',
        state: state.status,
        daysPastDue: 0,
        daysBefore: [],
        overdueDays: [1],
        sent: new Set(),
      }),
    ).toBeNull();
  });
});
