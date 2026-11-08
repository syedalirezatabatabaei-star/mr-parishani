import * as z from 'zod';
import { isValidJalaliDate } from '../jalali/calendar.js';
import { normalizePersianText } from '../text/persian.js';

/**
 * The holiday calendar (task 2-1, doc 08 §5). Days are entered and shown in the Jalali
 * calendar (rule 21) and stored as the Gregorian day they are in Tehran.
 */

export const holidayCityCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const cityCode = holidayCityCodeSchema;

export const jalaliDaySchema = z
  .object({
    year: z.number().int(),
    month: z.number().int(),
    day: z.number().int(),
  })
  .refine(isValidJalaliDate, { message: 'not a Jalali day' });

const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));

export const createHolidaySchema = z.object({
  on: jalaliDaySchema,
  title: text(2, 200),
  /** Omitted: a national holiday. */
  cityCode: cityCode.optional(),
  reason: text(3, 500),
});
export type CreateHoliday = z.input<typeof createHolidaySchema>;

export const removeHolidaySchema = z.object({ reason: text(3, 500) });

/** Longest range one request may list: a little over a year. */
export const MAX_HOLIDAY_RANGE_DAYS = 400;

/** From and to are Gregorian days, YYYY-MM-DD, inclusive. */
export const holidayQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    cityCode: cityCode.optional(),
  })
  .refine(
    (q) => {
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      return days >= 0 && days <= MAX_HOLIDAY_RANGE_DAYS;
    },
    { message: `from..to must be 0..${String(MAX_HOLIDAY_RANGE_DAYS)} days` },
  );

/** `GET /calendar/holidays`: each holiday's Tehran day as a Gregorian YYYY-MM-DD. */
export const holidayListSchema = z.array(
  z.object({
    id: z.uuid(),
    on: z.iso.date(),
    title: z.string(),
    kind: z.enum(['national', 'city']),
    cityCode: z.string().nullable(),
  }),
);

/** One holiday (an element of `GET /calendar/holidays`); what create and remove answer. */
export const holidayViewSchema = holidayListSchema.element;

/** `GET /config/notices`: open notices addressed to a permission the caller holds. */
export const adminNoticeListSchema = z.array(
  z.object({
    id: z.uuid(),
    code: z.string(),
    message: z.string(),
    firstRaisedAt: z.iso.datetime({ offset: true }),
    lastRaisedAt: z.iso.datetime({ offset: true }),
    raiseCount: z.int().positive(),
  }),
);
