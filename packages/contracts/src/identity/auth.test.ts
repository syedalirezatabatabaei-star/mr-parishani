import { describe, expect, it } from 'vitest';
import { otpVerifySchema, totpCodeSchema } from './auth.js';

const otp = (code: string) =>
  otpVerifySchema.safeParse({ mobile: '09121234567', code, client: 'mobile' });

describe('one-time codes', () => {
  it('accepts Persian and Arabic-Indic digits and stores them as ASCII (rule 23)', () => {
    expect(otp('۴۸۲۹۱۳')).toMatchObject({ success: true, data: { code: '482913' } });
    expect(otp('٤٨٢٩١٣')).toMatchObject({ success: true, data: { code: '482913' } });
    expect(totpCodeSchema.safeParse({ code: '۰۰۱۲۳۴' })).toMatchObject({
      success: true,
      data: { code: '001234' },
    });
  });

  it('accepts ASCII digits unchanged', () => {
    expect(otp('482913')).toMatchObject({ success: true, data: { code: '482913' } });
  });

  it('still refuses anything that is not exactly six digits', () => {
    for (const code of ['48291', '4829134', '', '48291a', '۴۸۲۹۱', '۴۸۲۹۱۳۴', '４８２９１３']) {
      expect(otp(code).success, code).toBe(false);
    }
  });
});
