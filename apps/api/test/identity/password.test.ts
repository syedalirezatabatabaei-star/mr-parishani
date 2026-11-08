import { describe, expect, it } from 'vitest';
import { weakPasswordReason } from '../../src/modules/identity/password';

/** Task 9-3 (R13; ASVS 2.1.7): the obviously guessable passwords, by local rules only. */
describe('weakPasswordReason', () => {
  it('refuses the username, one repeated character, digits only and well-known passwords', () => {
    expect(weakPasswordReason('maryam-is-staff-2026', 'maryam')).toBe('password_has_username');
    expect(weakPasswordReason('aaaaaaaaaaaa', 'someone')).toBe('password_repeated');
    expect(weakPasswordReason('091212345678', 'someone')).toBe('password_digits_only');
    expect(weakPasswordReason('Password1234', 'someone')).toBe('password_common');
    expect(weakPasswordReason('qwertyuiop12', 'someone')).toBe('password_common');
  });

  it('lets an ordinary long password through, the test accounts’ own among them', () => {
    expect(weakPasswordReason('a long enough password', 'staff1a2b3c4d')).toBeNull();
    expect(weakPasswordReason('e2e stack password, long enough', 'doctor')).toBeNull();
    expect(weakPasswordReason('گذرواژه‌ای بلند و فارسی', 'someone')).toBeNull();
    // A well-known word inside a much longer phrase is the phrase's strength, not a reason.
    expect(weakPasswordReason('my password is a long sentence', 'someone')).toBeNull();
  });
});
