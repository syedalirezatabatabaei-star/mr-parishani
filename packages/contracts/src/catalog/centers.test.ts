import { describe, expect, it } from 'vitest';
import { createCenterSchema, proposeBankAccountSchema, updateCenterSchema } from './centers.js';

const base = {
  personType: 'natural' as const,
  identifier: '۰۰۱۲۳۴۵۶۷۹', // Persian digits, normalized before the checksum
  name: 'كلينيك نمونه',
  cityCode: 'tehran',
};

describe('center request schemas', () => {
  it('normalize the identifier by person type and the text by rule 23', () => {
    const parsed = createCenterSchema.parse(base);
    expect(parsed.identifier).toBe('0012345679');
    expect(parsed.name).toBe('کلینیک نمونه');
    expect(createCenterSchema.safeParse({ ...base, personType: 'legal' }).success).toBe(false);
    expect(
      createCenterSchema.safeParse({ ...base, personType: 'legal', identifier: '10380284790' })
        .success,
    ).toBe(true);
  });

  it('take coordinates in degrees and store millionths as integers', () => {
    const parsed = createCenterSchema.parse({
      ...base,
      location: { latitude: 35.6892, longitude: 51.389 },
    });
    expect(parsed.location).toEqual({ latitude: 35_689_200, longitude: 51_389_000 });
    expect(
      createCenterSchema.safeParse({ ...base, location: { latitude: 91, longitude: 0 } }).success,
    ).toBe(false);
  });

  it('need a Sheba and its account holder together, and a valid Sheba', () => {
    expect(
      createCenterSchema.safeParse({ ...base, sheba: 'IR580540105180021273113007' }).success,
    ).toBe(false);
    const both = createCenterSchema.parse({
      ...base,
      sheba: 'ir58 0540 1051 8002 1273 1130 07',
      accountHolderName: 'صاحب حساب',
    });
    expect(both.sheba).toBe('IR580540105180021273113007');
    expect(
      proposeBankAccountSchema.safeParse({
        sheba: 'IR580540105180021273113008',
        accountHolderName: 'صاحب',
        reason: 'تغییر حساب',
      }).success,
    ).toBe(false);
  });

  it('change identity only with both the person type and the identifier, and a reason', () => {
    expect(
      updateCenterSchema.safeParse({ identifier: '0012345679', reason: 'اصلاح' }).success,
    ).toBe(false);
    expect(updateCenterSchema.safeParse({ phone: '021-8877 6655', reason: 'اصلاح' }).success).toBe(
      true,
    );
    expect(updateCenterSchema.safeParse({ phone: '02188776655' }).success).toBe(false);
  });
});
