/**
 * Digits are stored and compared as ASCII 0–9 (rule 23). Persian digits are for display
 * only.
 */

const PERSIAN_ZERO = 0x06f0; // ۰
const ARABIC_ZERO = 0x0660; // ٠
const PERSIAN_OR_ARABIC_DIGIT = /[\u06F0-\u06F9\u0660-\u0669]/g;
const ASCII_DIGIT = /[0-9]/g;

/** Persian (۰–۹) and Arabic-Indic (٠–٩) digits → ASCII 0–9. Other characters unchanged. */
export function normalizeDigits(input: string): string {
  return input.replace(PERSIAN_OR_ARABIC_DIGIT, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code - (code >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_ZERO));
  });
}

/** ASCII digits → Persian digits, for display. Other characters unchanged. */
export function toPersianDigits(input: string | number | bigint): string {
  return String(input).replace(ASCII_DIGIT, (ch) => String.fromCharCode(PERSIAN_ZERO + Number(ch)));
}
