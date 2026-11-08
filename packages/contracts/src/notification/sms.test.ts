import { describe, expect, it } from 'vitest';
import {
  forbiddenFields,
  nextAllowedAt,
  renderTemplate,
  smsSegments,
  templateFields,
} from './sms.js';

describe('SMS parts (doc 15 §7: Persian 70 a part)', () => {
  it('Persian: 70 in one part, 67 a part beyond', () => {
    expect(smsSegments('س'.repeat(70))).toBe(1);
    expect(smsSegments('س'.repeat(71))).toBe(2);
    expect(smsSegments('س'.repeat(134))).toBe(2);
    expect(smsSegments('س'.repeat(135))).toBe(3);
  });

  it('Latin (GSM-7): 160 in one part, 153 beyond; an extended character counts twice', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments(`${'a'.repeat(159)}€`)).toBe(2);
    // One Persian letter makes the whole text UCS-2.
    expect(smsSegments(`${'a'.repeat(69)}س`)).toBe(1);
    expect(smsSegments(`${'a'.repeat(70)}س`)).toBe(2);
    expect(smsSegments('')).toBe(0);
  });
});

describe("a template's fields (doc 15 §7, test 6)", () => {
  it('a guarantor never sees the treatment, the doctor or the center', () => {
    expect(
      forbiddenFields('guarantor', 'قسط {{amount}} {{doctor_name}} {{treatment_field}}'),
    ).toEqual(['doctor_name', 'treatment_field']);
    expect(forbiddenFields('patient', 'نوبت {{doctor_name}} در {{center_name}}')).toEqual([]);
    expect(forbiddenFields('borrower', 'امتیاز {{credit_score}}')).toEqual(['credit_score']);
  });

  it('fills every field, and refuses one without a value', () => {
    expect(templateFields('{{name}} و {{ amount }} و {{name}}')).toEqual(['name', 'amount']);
    expect(renderTemplate('سلام {{name}}، {{ amount }}', { name: 'علی', amount: '۱۰' })).toBe(
      'سلام علی، ۱۰',
    );
    expect(() => renderTemplate('{{name}}', {})).toThrow(RangeError);
  });
});

describe('the allowed hours, Tehran (doc 15 §7, test 9)', () => {
  const hours = { fromHour: 8, toHour: 21 };
  // Tehran is UTC+03:30.
  it('inside the window: now', () => {
    const at = new Date('2026-10-06T10:00:00Z'); // 13:30 Tehran
    expect(nextAllowedAt(at, hours)).toEqual(at);
  });

  it('after it closes: tomorrow at 8, Tehran', () => {
    expect(nextAllowedAt(new Date('2026-10-06T18:30:00Z'), hours)).toEqual(
      new Date('2026-10-07T04:30:00Z'),
    );
  });

  it('after midnight, before it opens: the same Tehran day at 8', () => {
    expect(nextAllowedAt(new Date('2026-10-06T21:00:00Z'), hours)).toEqual(
      new Date('2026-10-07T04:30:00Z'),
    );
    // 07:59 Tehran.
    expect(nextAllowedAt(new Date('2026-10-07T04:29:00Z'), hours)).toEqual(
      new Date('2026-10-07T04:30:00Z'),
    );
  });
});
