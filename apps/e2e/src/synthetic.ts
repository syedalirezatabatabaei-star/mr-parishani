import { randomInt } from 'node:crypto';

/**
 * Made-up but well-formed values for the seed and the tester's staging data (task 9-4):
 * check digits right, so validation passes, and nothing taken from a real person.
 */

export const digits = (n: number) =>
  Array.from({ length: n }, () => String(randomInt(10))).join('');

export const pick = <T>(items: readonly T[]): T => {
  const item = items[randomInt(items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
};

/** A valid Iranian national id (check digit). */
export function nationalId(): string {
  const body = digits(9);
  const sum = Array.from(body).reduce((s, d, i) => s + Number(d) * (10 - i), 0) % 11;
  return body + String(sum < 2 ? sum : 11 - sum);
}

/** A valid IBAN-checked Sheba number. */
export function sheba(): string {
  const bban = `0${digits(21)}`;
  const numeric = `${bban}182700`;
  let rest = 0;
  for (const ch of numeric) rest = (rest * 10 + Number(ch)) % 97;
  return `IR${String(98 - rest).padStart(2, '0')}${bban}`;
}

const FIRST = [
  'مریم',
  'زهرا',
  'فاطمه',
  'سارا',
  'نگار',
  'الهام',
  'مینا',
  'لیلا',
  'علی',
  'محمد',
  'رضا',
  'حسین',
  'مهدی',
  'امیر',
  'سعید',
  'کاوه',
] as const;

const LAST = [
  'احمدی',
  'محمدی',
  'کریمی',
  'رضایی',
  'موسوی',
  'حسینی',
  'جعفری',
  'صادقی',
  'نوری',
  'طاهری',
  'اصفهانی',
  'شریفی',
  'یزدانی',
  'فرهادی',
] as const;

/** A first and last name from common Persian names, put together at random. */
export function personName(): string {
  return `${pick(FIRST)} ${pick(LAST)}`;
}

/** A 9XXXXXXXXX mobile on a test prefix (the stack's SMS is the development console). */
export function mobile(prefix: '914' | '915' = '914'): string {
  return `${prefix}${digits(7)}`;
}
