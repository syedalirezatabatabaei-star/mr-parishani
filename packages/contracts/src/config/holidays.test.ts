import { describe, expect, it } from 'vitest';
import { createHolidaySchema, holidayQuerySchema } from './holidays.js';

describe('holiday request schemas', () => {
  const holiday = {
    on: { year: 1405, month: 1, day: 12 },
    title: 'روز جمهوری اسلامی',
    reason: 'تقویم رسمی',
  };

  it('take a real Jalali day, national or for a city code', () => {
    expect(createHolidaySchema.safeParse(holiday).success).toBe(true);
    expect(createHolidaySchema.safeParse({ ...holiday, cityCode: 'tabriz' }).success).toBe(true);
    expect(createHolidaySchema.safeParse({ ...holiday, cityCode: 'Tabriz' }).success).toBe(false);
    expect(
      createHolidaySchema.safeParse({ ...holiday, on: { year: 1405, month: 7, day: 31 } }).success,
    ).toBe(false);
    expect(createHolidaySchema.safeParse({ ...holiday, reason: '' }).success).toBe(false);
  });

  it('normalize Arabic letters in the title (rule 23)', () => {
    const parsed = createHolidaySchema.parse({ ...holiday, title: 'عيد فطر' });
    expect(parsed.title).toBe('عید فطر');
  });

  it('limit a listing to a bounded, ordered range', () => {
    expect(holidayQuerySchema.safeParse({ from: '2026-03-21', to: '2027-03-20' }).success).toBe(
      true,
    );
    expect(holidayQuerySchema.safeParse({ from: '2026-03-21', to: '2026-03-20' }).success).toBe(
      false,
    );
    expect(holidayQuerySchema.safeParse({ from: '2026-01-01', to: '2028-01-01' }).success).toBe(
      false,
    );
  });
});
