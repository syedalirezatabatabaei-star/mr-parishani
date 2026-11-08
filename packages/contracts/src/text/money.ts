import { normalizeDigits, toPersianDigits } from './digits.js';

/**
 * The one formatter of money for people (owner, 1405/07/11; ADR-035): the screens, the
 * API's PDFs and the SMS all use it. Rials are what is stored (rule 1); tomans are what
 * people read (rule 2), and the rials a toman cannot hold are never dropped silently.
 */

type Amount = bigint | string | number;

function toBigInt(value: Amount): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    // Rule 1: a JS number is accepted only when it is a whole, safe integer.
    if (!Number.isSafeInteger(value)) throw new RangeError(`not a whole rial: ${String(value)}`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new RangeError(`not a whole rial: ${value}`);
  return BigInt(value);
}

/** Digits grouped by three with the Persian thousands separator, in Persian digits. */
export function groupedDigits(value: Amount): string {
  const n = toBigInt(value);
  const sign = n < 0n ? '−' : '';
  const abs = n < 0n ? -n : n;
  return sign + toPersianDigits(abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '٬'));
}

/** Exactly, in rials: «۲۴۶٬۹۱۴ ریال». */
export function formatRial(rial: Amount): string {
  return `${groupedDigits(rial)} ریال`;
}

/**
 * Exactly, in tomans and the rials left: «۲۴٬۶۹۱ تومان و ۴ ریال», or «۲۴٬۶۹۱ تومان» when
 * the amount is whole tomans. Never rounded, never truncated.
 */
export function formatToman(rial: Amount): string {
  const n = toBigInt(rial);
  const sign = n < 0n ? '−' : '';
  const abs = n < 0n ? -n : n;
  const tomans = abs / 10n;
  const rest = abs % 10n;
  const head = `${sign}${groupedDigits(tomans)} تومان`;
  return rest === 0n ? head : `${head} و ${toPersianDigits(rest.toString())} ریال`;
}

/**
 * Rials as a person types them, in any digits, with or without separators; null unless a
 * whole number of at most 16 digits (rule 1: never a fraction, never tomans).
 */
export function parseRial(typed: string): bigint | null {
  const digits = normalizeDigits(typed).replace(/[\s,٬،_]/g, '');
  if (!/^\d{1,16}$/.test(digits)) return null;
  return BigInt(digits);
}
