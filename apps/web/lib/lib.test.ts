import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPOINTMENT_STATUS, patientMayCancel } from './appointments';
import { publicOrigin } from './origin';
import { apiDay, defined, one, pageOf } from './params';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('params', () => {
  it('one value per key; repeated or blank is missing', () => {
    expect(one({ q: ' علی ' }, 'q')).toBe('علی');
    expect(one({ q: ['a', 'b'] }, 'q')).toBeUndefined();
    expect(one({ q: '  ' }, 'q')).toBeUndefined();
  });

  it('a page number is a positive integer, else 1', () => {
    expect(pageOf({ page: '3' })).toBe(3);
    expect(pageOf({ page: '0' })).toBe(1);
    expect(pageOf({ page: '-2' })).toBe(1);
    expect(pageOf({ page: 'x' })).toBe(1);
    expect(pageOf({})).toBe(1);
  });

  it('a Jalali day becomes the API day; empty keys leave the query', () => {
    expect(apiDay({ year: 1405, month: 7, day: 8 })).toBe('2026-09-30');
    expect(defined({ a: 'x', b: undefined, c: '' })).toEqual({ a: 'x', c: '' });
  });
});

describe('appointments', () => {
  it('every status has a Persian label', () => {
    for (const { label } of Object.values(APPOINTMENT_STATUS)) expect(label).toMatch(/[آ-ی]/);
  });

  it('a patient may try to cancel an active appointment that has not started', () => {
    const now = Date.parse('2026-10-01T10:00:00Z');
    const later = '2026-10-02T10:00:00Z';
    expect(patientMayCancel({ status: 'confirmed', startsAt: later }, now)).toBe(true);
    expect(patientMayCancel({ status: 'requested', startsAt: later }, now)).toBe(true);
    expect(patientMayCancel({ status: 'examined', startsAt: later }, now)).toBe(false);
    expect(patientMayCancel({ status: 'confirmed', startsAt: '2026-10-01T09:00:00Z' }, now)).toBe(
      false,
    );
  });
});

describe('publicOrigin', () => {
  it('is the configured origin without a trailing slash', () => {
    vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://app.sepehr.example/');
    expect(publicOrigin()).toBe('https://app.sepehr.example');
  });
});
