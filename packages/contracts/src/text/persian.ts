import { normalizeDigits } from './digits.js';

const ZWNJ = '\u200C'; // نیم‌فاصله

/**
 * Canonical form of Persian text, applied before storing and before every search
 * (rule 23). Idempotent: normalizing twice gives the same result.
 *
 * - Unicode NFKC: Arabic presentation forms become base letters, NBSP becomes a space.
 * - Arabic ي and ى → Persian ی; Arabic ك → Persian ک.
 * - Persian and Arabic digits → ASCII.
 * - Tatweel (ـ), zero-width spaces, BOM and bidi control marks are removed.
 * - ZWNJ (half-space) is kept but deduplicated, and dropped at word edges.
 * - Runs of spaces and tabs become one space; each line and the whole text are trimmed.
 *   Line breaks are kept (as \n).
 *
 * Diacritics (harakat) are left as typed.
 */
export function normalizePersianText(input: string): string {
  const text = normalizeDigits(input.normalize('NFKC'))
    .replace(/[\u064A\u0649]/g, 'ی')
    .replace(/\u0643/g, 'ک')
    .replace(/[\u0640\u200B\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\u200C{2,}/g, ZWNJ);

  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/ ?\u200C ?/g, (m) => (m === ZWNJ ? ZWNJ : ' '))
        .replace(/ {2,}/g, ' ')
        .trim()
        .replace(/^\u200C+|\u200C+$/g, ''),
    )
    .join('\n')
    .trim();
}
