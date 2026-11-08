import { normalizeDigits } from './digits.js';

const ELEVEN_DIGITS = /^\d{11}$/;
const WEIGHTS = [29, 27, 23, 19, 17, 29, 27, 23, 19, 17] as const;

/**
 * Checksum of the national ID of a legal entity (شناسه ملی اشخاص حقوقی), 11 digits d0…d10:
 * with e = d9 + 2, s = Σ (d[i] + e)·w[i] for i = 0…9 (w = 29, 27, 23, 19, 17, repeated) and
 * r = s mod 11 (10 counts as 0); valid when d10 = r. An ID whose serial part (d3…d8) is all
 * zeros is not issued, so it is rejected.
 */
export function isValidLegalId(id: string): boolean {
  if (!ELEVEN_DIGITS.test(id) || id.slice(3, 9) === '000000') return false;
  const d = Array.from({ length: 11 }, (_, i) => id.charCodeAt(i) - 48);
  const e = (d[9] ?? 0) + 2;
  let sum = 0;
  WEIGHTS.forEach((w, i) => {
    sum += ((d[i] ?? 0) + e) * w;
  });
  const r = sum % 11 === 10 ? 0 : sum % 11;
  return d[10] === r;
}

/**
 * Legal-entity ID in stored form: exactly eleven ASCII digits. Accepts Persian or Arabic
 * digits, spaces and dashes; returns null unless the result passes the checksum.
 * Idempotent.
 */
export function normalizeLegalId(input: string): string | null {
  const digits = normalizeDigits(input).replace(/[\s\-‌‎‏]/g, '');
  return isValidLegalId(digits) ? digits : null;
}
