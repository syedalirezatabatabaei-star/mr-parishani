import { normalizeDigits } from './digits.js';

const TEN_DIGITS = /^\d{10}$/;

/**
 * Checksum of the Iranian national ID (کد ملی): with digits d0…d9,
 * s = Σ d[i]·(10 − i) for i = 0…8 and r = s mod 11; valid when d9 = r for r < 2, or
 * d9 = 11 − r otherwise. IDs of one repeated digit pass the checksum but are not issued,
 * so they are rejected.
 */
export function isValidNationalId(id: string): boolean {
  if (!TEN_DIGITS.test(id) || /^(\d)\1{9}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(id[i]) * (10 - i);
  const r = sum % 11;
  const check = Number(id[9]);
  return r < 2 ? check === r : check === 11 - r;
}

/**
 * National ID in stored form: exactly ten ASCII digits, leading zeros kept (doc 05).
 * Accepts Persian or Arabic digits, spaces and dashes. Input of 8 or 9 digits (leading
 * zeros lost, e.g. by a spreadsheet) is padded with zeros to ten digits first; fewer than
 * 8 or more than 10 digits is rejected. Returns null unless the padded result passes the
 * checksum. Idempotent.
 */
export function normalizeNationalId(input: string): string | null {
  const digits = normalizeDigits(input).replace(/[\s\-\u200C\u200E\u200F]/g, '');
  if (!/^\d{8,10}$/.test(digits)) return null;
  const id = digits.padStart(10, '0');
  return isValidNationalId(id) ? id : null;
}
