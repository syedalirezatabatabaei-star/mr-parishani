import { describe, expect, it } from 'vitest';
import { isValidLegalId, normalizeLegalId } from './legal-id.js';
import { normalizeMedicalCouncilNumber } from './medical-council.js';
import { isValidSheba, normalizeSheba } from './sheba.js';

describe('legal-entity national ID (شناسه ملی)', () => {
  it('accepts a real ID and rejects a changed digit', () => {
    expect(isValidLegalId('10380284790')).toBe(true);
    // Digit 9 also enters every term of the sum, so the official checksum does not catch
    // every change to it (e.g. 10380284700 passes); the others it always does.
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]) {
      const digit = Number('10380284790'[i]);
      const changed = `${'10380284790'.slice(0, i)}${String((digit + 1) % 10)}${'10380284790'.slice(i + 1)}`;
      expect(isValidLegalId(changed)).toBe(false);
    }
  });

  it('rejects the wrong length and an all-zero serial', () => {
    expect(isValidLegalId('1038028479')).toBe(false);
    expect(isValidLegalId('103802847901')).toBe(false);
    expect(isValidLegalId('10300000000')).toBe(false);
  });

  it('normalizes Persian digits and separators, idempotently', () => {
    expect(normalizeLegalId('۱۰۳۸۰-۲۸۴ ۷۹۰')).toBe('10380284790');
    expect(normalizeLegalId('10380284790')).toBe('10380284790');
    expect(normalizeLegalId('10380284791')).toBeNull();
  });
});

describe('Sheba (IBAN)', () => {
  const valid = 'IR580540105180021273113007';

  it('accepts a real Sheba and rejects any single changed digit', () => {
    expect(isValidSheba(valid)).toBe(true);
    expect(isValidSheba('IR062960000000100324200001')).toBe(true);
    for (let i = 2; i < valid.length; i++) {
      const digit = Number(valid[i]);
      const changed = `${valid.slice(0, i)}${String((digit + 1) % 10)}${valid.slice(i + 1)}`;
      expect(isValidSheba(changed)).toBe(false);
    }
  });

  it('rejects other countries and lengths', () => {
    expect(isValidSheba('DE89370400440532013000')).toBe(false);
    expect(isValidSheba('IR58054010518002127311300')).toBe(false);
  });

  it('normalizes spacing, case, Persian digits and a missing IR', () => {
    expect(normalizeSheba('ir58 0540 1051 8002 1273 1130 07')).toBe(valid);
    expect(normalizeSheba('۵۸۰۵۴۰۱۰۵۱۸۰۰۲۱۲۷۳۱۱۳۰۰۷')).toBe(valid);
    expect(normalizeSheba(valid)).toBe(valid);
    expect(normalizeSheba('IR580540105180021273113008')).toBeNull();
  });
});

describe('medical council number (شماره نظام پزشکی)', () => {
  it('normalizes Persian digits and separators, idempotently', () => {
    expect(normalizeMedicalCouncilNumber('۱۲۳-۴۵۶')).toBe('123456');
    expect(normalizeMedicalCouncilNumber('123456')).toBe('123456');
  });

  it('rejects letters, a leading zero and the wrong length', () => {
    expect(normalizeMedicalCouncilNumber('پ-12345')).toBeNull();
    expect(normalizeMedicalCouncilNumber('012345')).toBeNull();
    expect(normalizeMedicalCouncilNumber('12')).toBeNull();
    expect(normalizeMedicalCouncilNumber('123456789')).toBeNull();
  });
});
