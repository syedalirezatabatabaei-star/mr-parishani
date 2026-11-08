import { normalizeDigits } from './digits.js';

const COUNCIL_NUMBER = /^[1-9]\d{2,7}$/;

/**
 * Medical council number (شماره نظام پزشکی) in stored form: 3 to 8 ASCII digits, no leading
 * zero. Accepts Persian or Arabic digits, spaces and dashes; returns null otherwise.
 * Idempotent. It has no checksum, so the network specialist verifies it against the
 * council's register.
 * TODO(decision): numbers of other professions with a letter prefix (e.g. «پ» or «ط»).
 */
export function normalizeMedicalCouncilNumber(input: string): string | null {
  const digits = normalizeDigits(input).replace(/[\s\-‌‎‏]/g, '');
  return COUNCIL_NUMBER.test(digits) ? digits : null;
}
