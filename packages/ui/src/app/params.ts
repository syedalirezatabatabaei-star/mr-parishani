import { gregorianDayOf, toJalali, type JalaliDate } from '@sepehr/contracts';

export type SearchParams = Record<string, string | string[] | undefined>;

/** One value of a query parameter; a repeated or empty one counts as missing. */
export const one = (params: SearchParams, key: string): string | undefined => {
  const value = params[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

/** A positive page number from the URL, else 1. */
export const pageOf = (params: SearchParams): number => {
  const n = Number(one(params, 'page'));
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : 1;
};

/** Today in Tehran, as a Jalali day (ADR-011: what the pages show and take). */
export const tehranToday = (): JalaliDate => toJalali(new Date());

/** A Jalali day as the API's Tehran day (Gregorian `YYYY-MM-DD`), never shown. */
export const apiDay = (day: JalaliDate): string => gregorianDayOf(day);

/** An API query without its empty keys (the generated types do not take `undefined`). */
export function defined<T extends Record<string, unknown>>(
  query: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
