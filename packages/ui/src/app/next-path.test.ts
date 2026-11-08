import { describe, expect, it } from 'vitest';
import { safeNext } from './next-path.js';

describe('safeNext: no open redirect after sign-in', () => {
  it.each([
    ['/me/appointments', '/me/appointments'],
    ['/panel/appointments?status=pending', '/panel/appointments?status=pending'],
    ['//evil.example/x', '/home'],
    ['/\\evil.example', '/home'],
    ['https://evil.example', '/home'],
    ['javascript:alert(1)', '/home'],
    ['/a\tb', '/home'],
    ['', '/home'],
  ])('%s → %s', (value, expected) => {
    expect(safeNext(value, '/home')).toBe(expected);
  });

  it('a repeated parameter or none gives the fallback', () => {
    expect(safeNext(['/a', '/b'], '/home')).toBe('/home');
    expect(safeNext(undefined, '/home')).toBe('/home');
  });
});
