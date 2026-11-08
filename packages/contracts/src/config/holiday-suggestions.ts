import * as z from 'zod';
import { jalaliMonthLength, type JalaliDate } from '../jalali/calendar.js';
import { gregorianDayOf, nextJalaliDay } from '../jalali/working-days.js';
import { normalizePersianText } from '../text/persian.js';
import { holidayCityCodeSchema, jalaliDaySchema } from './holidays.js';

/**
 * Suggested official holidays of a Jalali year (owner 1405/07/23, plan 3, f5; ADR-043): the
 * rules in `calendar.holiday_rules` laid on the year. Solar days are exact; lunar days are
 * computed offline with the Umm al-Qura calendar of the runtime (rule 18: no outside service)
 * and are an estimate, ±1 day of the day Iran announces (ADR-011): the admin checks each. A
 * suggestion is only a preview: nothing is a holiday until the admin saves it.
 */

const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));

/** The longest each Jalali month can be: 31 to Shahrivar, 30 to Bahman, Esfand 30 in a leap year. */
const JALALI_MONTH_MAX = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30] as const;

const holidayRule = z.object({
  month: z.int().min(1).max(12),
  day: z.int().min(1).max(31),
  title: text(3, 100),
});
export type HolidayRule = z.output<typeof holidayRule>;

const unique = (rules: readonly HolidayRule[]) =>
  new Set(rules.map((r) => `${String(r.month)}-${String(r.day)}`)).size === rules.length;

/**
 * `calendar.holiday_rules`: fixed solar days and lunar (Hijri) days. A lunar day 30 means the
 * month's last day, 29 in a short month (the end of Safar, e.g.).
 */
export const holidayRulesSchema = z.object({
  solar: z
    .array(holidayRule)
    .max(40)
    .refine((rules) => rules.every((r) => r.day <= (JALALI_MONTH_MAX[r.month - 1] ?? 0)), {
      message: 'no such day in that Jalali month',
    })
    .refine(unique, { message: 'repeated day' }),
  lunar: z
    .array(holidayRule)
    .max(40)
    .refine((rules) => rules.every((r) => r.day <= 30), {
      message: 'a Hijri month has at most 30 days',
    })
    .refine(unique, { message: 'repeated day' }),
});
export type HolidayRules = z.output<typeof holidayRulesSchema>;

export interface HolidaySuggestion {
  /** Gregorian YYYY-MM-DD of the Tehran day, as `holidays` stores it. */
  readonly on: string;
  readonly jalali: JalaliDate;
  /** Two rules on one day give one suggestion, their titles joined. */
  readonly title: string;
  /** True when any rule of the day is lunar: ±1 day, the admin checks it. */
  readonly estimated: boolean;
}

interface HijriDay {
  readonly month: number;
  readonly day: number;
}

let hijriFormat: Intl.DateTimeFormat | undefined;

/** The Umm al-Qura day of a Gregorian day; noon UTC is the same day in Tehran. */
function hijriOf(gregorianDay: string): HijriDay {
  hijriFormat ??= new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = hijriFormat.formatToParts(new Date(`${gregorianDay}T12:00:00Z`));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { month: part('month'), day: part('day') };
}

/** Every suggested holiday of the Jalali year, in order of day. */
export function holidaySuggestions(year: number, rules: HolidayRules): HolidaySuggestion[] {
  const byDay = new Map<string, { jalali: JalaliDate; titles: string[]; estimated: boolean }>();
  const add = (jalali: JalaliDate, title: string, estimated: boolean) => {
    const on = gregorianDayOf(jalali);
    const found = byDay.get(on);
    if (found) {
      found.titles.push(title);
      found.estimated ||= estimated;
    } else {
      byDay.set(on, { jalali, titles: [title], estimated });
    }
  };

  // Solar: exact. 30 Esfand only in a leap year.
  for (const rule of rules.solar) {
    if (rule.day <= jalaliMonthLength(year, rule.month)) {
      add({ year, month: rule.month, day: rule.day }, rule.title, false);
    }
  }

  // Lunar: each day of the year, its Hijri day; a Jalali year may hold one twice.
  if (rules.lunar.length > 0) {
    const last: JalaliDate = { year, month: 12, day: jalaliMonthLength(year, 12) };
    let today: JalaliDate = { year, month: 1, day: 1 };
    let hijri = hijriOf(gregorianDayOf(today));
    for (;;) {
      const atEnd = today.month === last.month && today.day === last.day;
      const tomorrow = nextJalaliDay(today);
      const next = hijriOf(gregorianDayOf(tomorrow));
      // The last day of a 29-day month stands for day 30 as well.
      const monthEnds = next.day === 1 && hijri.day === 29;
      for (const rule of rules.lunar) {
        if (
          rule.month === hijri.month &&
          (rule.day === hijri.day || (rule.day === 30 && monthEnds))
        ) {
          add(today, rule.title, true);
        }
      }
      if (atEnd) break;
      today = tomorrow;
      hijri = next;
    }
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([on, d]) => ({
      on,
      jalali: d.jalali,
      title: d.titles.join('، '),
      estimated: d.estimated,
    }));
}

/** `GET /calendar/holidays/suggestions?year=`. */
export const holidaySuggestionQuerySchema = z.object({
  year: z.coerce.number().int().min(1400).max(1500),
});

/** One suggested day: whether it is already in the calendar, so it is not saved again. */
export const holidaySuggestionSchema = z.object({
  on: z.iso.date(),
  jalali: z.object({ year: z.int(), month: z.int(), day: z.int() }),
  title: z.string(),
  estimated: z.boolean(),
  /** A national holiday already on that day: shown, not saved again. */
  existing: z.boolean(),
});

export const holidaySuggestionsViewSchema = z.object({
  year: z.int(),
  /** The `calendar.holiday_rules` version the suggestions came from. */
  rulesVersionId: z.uuid(),
  days: z.array(holidaySuggestionSchema),
  /**
   * Plan 3 (a): contracts not yet funded with a printed due day on one of the new days. Should
   * repayment.shift_due_to_next_working_day be on for their case, funding moves that day
   * (ADR-021); the amounts never change.
   */
  contractsWithDueOnNewDays: z.int().nonnegative(),
});
export type HolidaySuggestionsView = z.output<typeof holidaySuggestionsViewSchema>;

/** Most days one batch may hold: every rule of a year, with room (0089 holds the same). */
export const MAX_HOLIDAY_BATCH = 60;

/**
 * `POST /calendar/holidays/batches` (owner 1405/07/24): national holidays of one Jalali year,
 * asked by one person and saved, all or none, once a second approves.
 */
export const createHolidayBatchSchema = z
  .object({
    year: z.int().min(1400).max(1500),
    days: z
      .array(
        z.object({
          on: jalaliDaySchema,
          title: text(2, 200),
          /** Owner 1405/07/27: a city's holiday too (omitted: national), as the single path had. */
          cityCode: holidayCityCodeSchema.optional(),
        }),
      )
      .min(1)
      .max(MAX_HOLIDAY_BATCH)
      .refine(
        (days) =>
          new Set(
            days.map(
              (d) =>
                `${String(d.on.month)}-${String(d.on.day)}-${String(d.on.year)}-${d.cityCode ?? ''}`,
            ),
          ).size === days.length,
        { message: 'repeated day' },
      ),
    reason: text(3, 500),
  })
  .refine((b) => b.days.every((d) => d.on.year === b.year), {
    message: 'every day in the year asked',
    path: ['days'],
  });
export type CreateHolidayBatch = z.input<typeof createHolidayBatchSchema>;

export const holidayBatchViewSchema = z.object({
  id: z.uuid(),
  year: z.int(),
  /** Gregorian YYYY-MM-DD of each Tehran day, with its title. */
  days: z.array(
    z.object({ on: z.iso.date(), title: z.string(), cityCode: z.string().nullable().optional() }),
  ),
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  requestedAt: z.iso.datetime({ offset: true }),
  requestedByMe: z.boolean(),
  /** Plan 3 (a) when asked. */
  affectedContractsAtRequest: z.int().nonnegative(),
  /**
   * Plan 3 (a) now, for a pending batch: what the approver sees before saving. Null once
   * decided.
   */
  affectedContractsNow: z.int().nonnegative().nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  savedCount: z.int().nullable(),
});
export type HolidayBatchView = z.output<typeof holidayBatchViewSchema>;
export const holidayBatchListSchema = z.array(holidayBatchViewSchema);

/**
 * `POST /calendar/holidays/removals` (owner 1405/07/29): a holiday taken off the calendar, asked
 * by one holder of config.manage_holidays with a reason and removed (soft delete, rule 7) only
 * once a second approves (ADR-043, as a batch adds one).
 */
export const requestHolidayRemovalSchema = z.object({
  holidayId: z.uuid(),
  reason: text(3, 500),
});
export type RequestHolidayRemoval = z.input<typeof requestHolidayRemovalSchema>;

export const holidayRemovalViewSchema = z.object({
  id: z.uuid(),
  holidayId: z.uuid(),
  /** Gregorian YYYY-MM-DD of the Tehran day. */
  on: z.iso.date(),
  title: z.string(),
  cityCode: z.string().nullable(),
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  requestedAt: z.iso.datetime({ offset: true }),
  requestedByMe: z.boolean(),
  /** Plan 3 (a) when asked: contracts not yet funded printing a due day on it (national only). */
  affectedContractsAtRequest: z.int().nonnegative(),
  /** The same count now, for a pending removal; null once decided. */
  affectedContractsNow: z.int().nonnegative().nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type HolidayRemovalView = z.output<typeof holidayRemovalViewSchema>;
export const holidayRemovalListSchema = z.array(holidayRemovalViewSchema);
