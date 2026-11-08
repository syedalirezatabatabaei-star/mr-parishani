import { daysBetween, type InstallmentState } from './state.js';

/**
 * Installment reminders and overdue notices (task 6-6; doc 15 §4; decision 6.3): which step
 * of one installment is due today. Pure; the API reads the installment, what was sent, and
 * sends the step through the SMS module (task 6-4).
 */

export type ReminderKind = 'before_due' | 'overdue';

export interface ReminderStep {
  readonly kind: ReminderKind;
  /** Days before the due day (before_due) or days past it (overdue). */
  readonly offsetDays: number;
}

/**
 * A step missed (a night the job did not run) is still sent this many days after its own
 * day, never later: no late burst of old notices. Technical, not a business number.
 */
export const REMINDER_CATCH_UP_DAYS = 3;

export const reminderKey = (step: ReminderStep) => `${step.kind}:${String(step.offsetDays)}`;

/**
 * The one step to send today, or null. Only an installment with something still owed:
 *
 * - before its due day (and on it): the latest of `daysBefore` reached;
 * - overdue (past its grace days): the latest of `overdueDays` reached, counted from the
 *   due day like daysPastDue;
 * - at most one per installment per day; a step already sent, or one passed more than
 *   {@link REMINDER_CATCH_UP_DAYS} ago, is not sent; a reminder is never sent once its
 *   due day has passed.
 */
export function reminderStep(input: {
  readonly dueOn: string;
  readonly today: string;
  readonly state: InstallmentState;
  readonly daysPastDue: number;
  readonly daysBefore: readonly number[];
  readonly overdueDays: readonly number[];
  readonly sent: ReadonlySet<string>;
}): ReminderStep | null {
  if (input.state === 'paid' || input.state === 'cancelled') return null;
  const latest = (offsets: readonly number[], reachedBy: (d: number) => boolean) =>
    offsets.filter(reachedBy).reduce<number | null>((a, d) => (a === null || d > a ? d : a), null);

  if (input.state === 'overdue') {
    const d = latest(input.overdueDays, (o) => o <= input.daysPastDue);
    if (d === null || input.daysPastDue - d > REMINDER_CATCH_UP_DAYS) return null;
    const step: ReminderStep = { kind: 'overdue', offsetDays: d };
    return input.sent.has(reminderKey(step)) ? null : step;
  }

  const until = daysBetween(input.today, input.dueOn);
  if (until < 0) return null;
  // The latest step reached is the nearest to the due day: the smallest offset >= until.
  const reached = input.daysBefore.filter((o) => o >= until);
  if (reached.length === 0) return null;
  const d = Math.min(...reached);
  if (d - until > REMINDER_CATCH_UP_DAYS) return null;
  const step: ReminderStep = { kind: 'before_due', offsetDays: d };
  return input.sent.has(reminderKey(step)) ? null : step;
}
