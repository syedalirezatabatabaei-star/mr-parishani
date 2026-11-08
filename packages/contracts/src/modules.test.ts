import { describe, expect, it } from 'vitest';
import { API_MODULES, isApiModule } from './modules.js';

describe('API_MODULES', () => {
  it('has no duplicates', () => {
    expect(new Set(API_MODULES).size).toBe(API_MODULES.length);
  });

  it('recognises module names', () => {
    expect(isApiModule('ledger')).toBe(true);
    expect(isApiModule('wallets')).toBe(false);
  });
});
