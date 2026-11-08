import { describe, expect, it } from 'vitest';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_STATUSES,
  APPOINTMENT_TRANSITIONS,
  canTransition,
  checkInSchema,
  visitPaymentSchema,
} from './appointments.js';

describe('appointment transitions (doc 08 §7, task 2-6 decision 5)', () => {
  it('follow the documented lifecycle and the two added moves', () => {
    expect(canTransition('held', 'requested')).toBe(true);
    expect(canTransition('held', 'confirmed')).toBe(false);
    expect(canTransition('requested', 'cancelled_by_patient')).toBe(true);
    expect(canTransition('requested', 'expired')).toBe(true);
    expect(canTransition('confirmed', 'rescheduled')).toBe(true);
    expect(canTransition('checked_in', 'examined')).toBe(true);
    expect(canTransition('no_show', 'confirmed')).toBe(false);
  });

  it('end in states that go nowhere, and only live states take a slot', () => {
    for (const status of APPOINTMENT_STATUSES) {
      for (const to of APPOINTMENT_TRANSITIONS[status]) expect(APPOINTMENT_STATUSES).toContain(to);
    }
    for (const end of ['rejected', 'expired', 'no_show', 'rescheduled'] as const) {
      expect(APPOINTMENT_TRANSITIONS[end]).toEqual([]);
      expect(ACTIVE_APPOINTMENT_STATUSES).not.toContain(end);
    }
  });
});

describe('appointment request schemas', () => {
  it('take Persian digits in a check-in code and an amount, never a number of rials', () => {
    expect(checkInSchema.parse({ code: '۱۲۳۴۵۶' }).code).toBe('123456');
    expect(checkInSchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(visitPaymentSchema.parse({ amountRial: '۵۰۰۰۰۰' }).amountRial).toBe('500000');
    expect(visitPaymentSchema.safeParse({ amountRial: 500000 }).success).toBe(false);
  });
});
