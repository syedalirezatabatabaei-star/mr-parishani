import { ApiError } from '@sepehr/api-client';
import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors.js';

describe('the credit committee vote messages (owner 1405/08/01)', () => {
  const codes = [
    ['proposer_cannot_vote', 409, 'پیشنهاددهنده این پرونده رأی نمی‌دهد.'],
    ['not_a_unit_member', 403, 'شما عضو این واحد کمیته نیستید.'],
    ['not_an_attendee', 403, 'نام شما در حاضران این صورت‌جلسه نیست.'],
    ['already_voted', 409, 'شما پیش‌تر به این پیشنهاد رأی داده‌اید.'],
    ['not_a_committee_decision', 409, 'این پیشنهاد با مرجع کمیته نیست.'],
    ['unknown_unit', 400, 'این واحد در فهرست واحدهای کمیته نیست.'],
  ] as const;

  it.each(codes)('%s reads in Persian, never as the code', (code, status, message) => {
    const shown = errorMessage(new ApiError(status, code));
    expect(shown).toBe(message);
    expect(shown).not.toContain(code);
  });
});
