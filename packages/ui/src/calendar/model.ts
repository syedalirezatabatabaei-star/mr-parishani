import {
  addJalaliDays,
  addJalaliMonths,
  compareJalali,
  gregorianDayOf,
  JALALI_MONTH_NAMES,
  jalaliMonthLength,
  startOfJalaliWeek,
  toPersianDigits,
  weekdayOf,
  type JalaliDate,
  type Weekday,
} from '@sepehr/contracts';

/**
 * The model of the one calendar (task 2-10, doc 08 §13): pure, so the component only draws
 * it. Every conversion goes through the Jalali wrapper of @sepehr/contracts.
 *
 * Only Jalali dates are ever shown (ADR-011, owner decision 1405/07/08): no Gregorian or
 * Hijri day anywhere. The Gregorian day appears only as `key`, an internal identifier that
 * matches the API (holidays, capacity, slots), never on screen.
 */

/** How full a day is, for booking (doc 08 §13): free, limited or full. */
export type Capacity = 'free' | 'limited' | 'full';

/** A holiday as the holidays API gives it: its Tehran day as a Gregorian YYYY-MM-DD. */
export interface HolidayMark {
  readonly on: string;
  readonly title: string;
}

export interface DateRange {
  readonly from: JalaliDate;
  readonly to: JalaliDate;
}

/** A range being picked: the first click sets `from`, the second `to`. */
export interface PendingRange {
  readonly from: JalaliDate;
  readonly to: JalaliDate | null;
}

/** A time that can be booked on a day (from the booking API's free slots). */
export interface DaySlot {
  readonly startsAt: string;
  /** Tehran wall time, HH:MM. */
  readonly time: string;
  readonly available: boolean;
}

export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  saturday: 'شنبه',
  sunday: 'یکشنبه',
  monday: 'دوشنبه',
  tuesday: 'سه‌شنبه',
  wednesday: 'چهارشنبه',
  thursday: 'پنجشنبه',
  friday: 'جمعه',
};

export const WEEKDAY_SHORT: readonly string[] = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

export const CAPACITY_NAMES: Readonly<Record<Capacity, string>> = {
  free: 'ظرفیت آزاد',
  limited: 'ظرفیت محدود',
  full: 'ظرفیت پر',
};

/** The key a day is known by in holidays, capacity and slots: its Gregorian day. */
export const dayKey = (date: JalaliDate): string => gregorianDayOf(date);

export const sameDay = (a: JalaliDate | null | undefined, b: JalaliDate | null | undefined) =>
  !!a && !!b && compareJalali(a, b) === 0;

export const fa = (n: number | string) => toPersianDigits(String(n));

export interface DayCell {
  readonly date: JalaliDate;
  readonly key: string;
  readonly inMonth: boolean;
  readonly weekday: Weekday;
}

function cell(date: JalaliDate, month: number): DayCell {
  return { date, key: dayKey(date), inMonth: date.month === month, weekday: weekdayOf(date) };
}

/** The six weeks (Saturday to Friday) that show a Jalali month, with days of its neighbors. */
export function monthGrid(year: number, month: number): DayCell[][] {
  const first = { year, month, day: 1 };
  // Always six weeks, as in enterprise pickers: the calendar keeps one height from month to
  // month, the days of the months around it filling the rest.
  const start = startOfJalaliWeek(first);
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => cell(addJalaliDays(start, 7 * w + i), month)),
  );
}

/** The seven days (Saturday to Friday) of the week of `date`. */
export function weekOf(date: JalaliDate): DayCell[] {
  const start = startOfJalaliWeek(date);
  return Array.from({ length: 7 }, (_, i) => cell(addJalaliDays(start, i), date.month));
}

/** The next state of a range pick: from, then to (in order), then a new from. */
export function pickRange(current: PendingRange | null, picked: JalaliDate): PendingRange {
  if (!current || current.to !== null) return { from: picked, to: null };
  return compareJalali(picked, current.from) < 0
    ? { from: picked, to: current.from }
    : { from: current.from, to: picked };
}

export const inRange = (date: JalaliDate, range: PendingRange | null) =>
  !!range &&
  compareJalali(date, range.from) >= 0 &&
  compareJalali(date, range.to ?? range.from) <= 0;

export type Shortcut = 'today' | 'this_week' | 'this_month' | 'last_month';

export const SHORTCUT_NAMES: Readonly<Record<Shortcut, string>> = {
  today: 'امروز',
  this_week: 'این هفته',
  this_month: 'این ماه',
  last_month: 'ماه گذشته',
};

/** The range a shortcut stands for, from `today` (doc 08 §13). */
export function shortcutRange(kind: Shortcut, today: JalaliDate): DateRange {
  switch (kind) {
    case 'today':
      return { from: today, to: today };
    case 'this_week': {
      const from = startOfJalaliWeek(today);
      return { from, to: addJalaliDays(from, 6) };
    }
    case 'this_month':
      return {
        from: { ...today, day: 1 },
        to: { ...today, day: jalaliMonthLength(today.year, today.month) },
      };
    case 'last_month': {
      const m = addJalaliMonths({ ...today, day: 1 }, -1);
      return { from: m, to: { ...m, day: jalaliMonthLength(m.year, m.month) } };
    }
  }
}

/** «۱۲ مهر ۱۴۰۵». */
export const jalaliLabel = (d: JalaliDate) =>
  `${fa(d.day)} ${JALALI_MONTH_NAMES[d.month - 1] ?? ''} ${fa(d.year)}`;

/** «مهر ۱۴۰۵». */
export const monthLabel = (year: number, month: number) =>
  `${JALALI_MONTH_NAMES[month - 1] ?? ''} ${fa(year)}`;

/**
 * What a screen reader says for a day: the weekday and the Jalali date, then a holiday and
 * the day's capacity when there is one.
 */
export function dayDescription(c: DayCell, holiday?: string, capacity?: Capacity): string {
  const parts = [`${WEEKDAY_NAMES[c.weekday]} ${jalaliLabel(c.date)}`];
  if (holiday) parts.push(`تعطیل: ${holiday}`);
  if (capacity) parts.push(CAPACITY_NAMES[capacity]);
  return parts.join('، ');
}
