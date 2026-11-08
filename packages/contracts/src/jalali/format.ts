import { normalizeDigits, toPersianDigits } from '../text/digits.js';
import { isValidJalaliDate, type JalaliDate } from './calendar.js';
import { toJalaliDateTime } from './tehran.js';

export const JALALI_MONTH_NAMES = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
] as const;

export interface JalaliFormatOptions {
  /** `numeric`: ۱۴۰۵/۰۶/۲۸ (default). `long`: ۲۸ شهریور ۱۴۰۵. */
  readonly style?: 'numeric' | 'long';
  /** `fa`: Persian digits (default). `latn`: ASCII digits. */
  readonly digits?: 'fa' | 'latn';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function withDigits(text: string, digits: JalaliFormatOptions['digits']): string {
  return digits === 'latn' ? text : toPersianDigits(text);
}

export function formatJalaliDate(date: JalaliDate, options: JalaliFormatOptions = {}): string {
  if (!isValidJalaliDate(date)) {
    throw new RangeError(
      `Invalid Jalali date ${String(date.year)}/${String(date.month)}/${String(date.day)}`,
    );
  }
  const text =
    options.style === 'long'
      ? `${String(date.day)} ${JALALI_MONTH_NAMES[date.month - 1] ?? ''} ${String(date.year)}`
      : `${String(date.year)}/${pad2(date.month)}/${pad2(date.day)}`;
  return withDigits(text, options.digits);
}

/** Date and Tehran wall-clock time of an instant: ۱۴۰۵/۰۶/۲۸ ۱۴:۳۰. */
export function formatJalaliDateTime(instant: Date, options: JalaliFormatOptions = {}): string {
  const dt = toJalaliDateTime(instant);
  const time = `${pad2(dt.hour)}:${pad2(dt.minute)}`;
  return `${formatJalaliDate(dt, options)} ${withDigits(time, options.digits)}`;
}

const NUMERIC_DATE = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/;

/**
 * Parses year/month/day typed by a user: Persian, Arabic or ASCII digits, separated by
 * `/`, `-` or `.`. Returns null unless it is a real Jalali date in the supported range.
 */
/** Direction marks and isolates (LRM, RLM, LRI…PDI): invisible, never part of a date. */
export const stripBidiMarks = (text: string) => text.replace(/[\u200e\u200f\u2066-\u2069]/g, '');

export function parseJalaliDate(input: string): JalaliDate | null {
  const match = NUMERIC_DATE.exec(stripBidiMarks(normalizeDigits(input)).trim());
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidJalaliDate(date) ? date : null;
}
