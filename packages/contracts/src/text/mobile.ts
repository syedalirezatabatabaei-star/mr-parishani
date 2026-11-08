import { normalizeDigits } from './digits.js';

const MOBILE = /^9\d{9}$/;

/**
 * Iranian mobile number in the one form used for storage and every comparison:
 * `9XXXXXXXXX` (rule 24, doc 05). Accepts Persian, Arabic or ASCII digits, spaces, dashes,
 * dots and parentheses, and the prefixes `+98`, `0098`, `98` and `0`. Returns null if the
 * result is not ten digits starting with 9. Idempotent.
 */
export function normalizeMobile(input: string): string | null {
  let digits = normalizeDigits(input).replace(/[\s\-.()\u200C\u200E\u200F]/g, '');
  if (digits.startsWith('+98')) digits = digits.slice(3);
  else if (digits.startsWith('0098')) digits = digits.slice(4);
  else if (/^98\d{10}$/.test(digits)) digits = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  return MOBILE.test(digits) ? digits : null;
}
