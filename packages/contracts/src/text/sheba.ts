import { normalizeDigits } from './digits.js';

const SHEBA = /^IR\d{24}$/;

/** ISO 13616 check: the four leading characters moved to the end, letters as 10…35, mod 97 = 1. */
function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

/** An Iranian IBAN (شبا): `IR` and 24 digits, passing the ISO 13616 check. */
export function isValidSheba(sheba: string): boolean {
  return SHEBA.test(sheba) && mod97(sheba) === 1;
}

/**
 * Sheba in stored form: `IR` and 24 ASCII digits. Accepts Persian or Arabic digits,
 * spaces, dashes, a lowercase `ir`, or the 24 digits alone. Returns null unless the result
 * passes the check. Idempotent.
 */
export function normalizeSheba(input: string): string | null {
  const compact = normalizeDigits(input)
    .replace(/[\s\-‌‎‏]/g, '')
    .toUpperCase();
  const sheba = /^\d{24}$/.test(compact) ? `IR${compact}` : compact;
  return isValidSheba(sheba) ? sheba : null;
}
