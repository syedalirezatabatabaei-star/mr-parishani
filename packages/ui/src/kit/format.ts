import {
  formatJalaliDate,
  JALALI_MONTH_NAMES,
  formatRial,
  formatToman,
  formatJalaliDateTime,
  gregorianToJalali,
  parseJalaliDate,
  toJalaliDateTime,
  toPersianDigits,
  type JalaliDate,
} from '@sepehr/contracts';

/**
 * What pages show of numbers, money and times. Every date goes through the Jalali wrapper of
 * @sepehr/contracts (ADR-011, lint rule jalali-display-only); nothing here formats a date
 * itself.
 */

export const faDigits = (value: number | bigint | string) => toPersianDigits(String(value));

/**
 * Rials are stored (rule 1); people read tomans (rule 2), exactly: «۲۴٬۶۹۱ تومان و ۴ ریال»
 * when a toman cannot hold the amount. The shared formatter of @sepehr/contracts (ADR-035).
 */
export const toman = (rial: bigint | string | number): string => formatToman(rial);

/** Rials exactly, grouped by three, with Persian digits (ADR-035). */
export const rial = (value: bigint | string | number): string => formatRial(value);

/**
 * A day the API sends as `YYYY-MM-DD` (a civil day: holidays `on`, slots, due dates) as a
 * Jalali day. Null when it is not such a day.
 */
export function jalaliOfDay(day: string): JalaliDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return gregorianToJalali({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
}

/** A `YYYY-MM-DD` day of the API, shown in Jalali (e.g. ۱۴۰۵/۰۷/۰۸). */
export function showDay(day: string, style: 'numeric' | 'long' = 'numeric'): string {
  const jalali = jalaliOfDay(day);
  return jalali ? formatJalaliDate(jalali, { style }) : '';
}

const instant = (at: string | Date) => (typeof at === 'string' ? new Date(at) : at);

/** An instant as its Tehran Jalali day and time, e.g. ۱۴۰۵/۰۷/۰۸ ۰۹:۳۰. */
export const showInstant = (at: string | Date) => formatJalaliDateTime(instant(at));

/** The Tehran day of an instant, e.g. ۸ مهر ۱۴۰۵. */
export const showInstantDay = (at: string | Date, style: 'numeric' | 'long' = 'long') =>
  formatJalaliDate(toJalaliDateTime(instant(at)), { style });

/** The Tehran time of an instant, e.g. ۰۹:۳۰. */
export function showTime(at: string | Date): string {
  const t = toJalaliDateTime(instant(at));
  return toPersianDigits(`${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`);
}

/**
 * A date in a filter's URL: the Jalali day with ASCII digits, `1405-07-08`. The address bar
 * shows only Jalali dates too (ADR-011); the page converts to what the API wants.
 */
export const jalaliParam = (d: JalaliDate) =>
  `${String(d.year)}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/** A URL date back to a Jalali day; null if missing or not a real day. */
export const parseJalaliParam = (value: string | readonly string[] | undefined) =>
  typeof value === 'string' && value !== '' ? parseJalaliDate(value) : null;

/** A Jalali month by its numbers, e.g. «آبان ۱۴۰۵» (a statement's period). */
export const showJalaliMonth = (year: number, month: number) =>
  `${JALALI_MONTH_NAMES[month - 1] ?? ''} ${toPersianDigits(String(year))}`;
