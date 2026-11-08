import * as z from 'zod';
import { jalaliDaySchema } from '../config/holidays.js';
import { WEEKDAYS } from '../jalali/working-days.js';
import { normalizeDigits } from '../text/digits.js';
import { normalizePersianText } from '../text/persian.js';

/**
 * A doctor's calendar at one workplace (task 2-5, doc 08 §6): the weekly schedule, the
 * exceptions on given days, and how the workplace approves appointments. Times are Tehran
 * wall-clock times of a day, `HH:MM` from 00:00 to 24:00, stored as minutes since midnight;
 * a range never crosses midnight. Days are entered in Jalali (rule 21).
 */

const code = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 500);

export const MINUTES_PER_DAY = 1440;

/** `HH:MM` (Persian digits accepted), 00:00 … 24:00, as minutes since midnight. */
export const wallTimeSchema = z
  .string()
  .transform(normalizeDigits)
  .pipe(z.string().regex(/^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/))
  .transform((v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)));

/** Minutes since midnight as `HH:MM`. */
export function formatWallTime(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Shortest and longest appointment a range may be cut into. */
export const MIN_SLOT_MINUTES = 5;
export const MAX_SLOT_MINUTES = 480;
const slotMinutes = z.number().int().min(MIN_SLOT_MINUTES).max(MAX_SLOT_MINUTES);
const serviceCodes = z
  .array(code)
  .min(1)
  .max(50)
  .refine((codes) => new Set(codes).size === codes.length, { message: 'repeated service' });

const fitsSlots = (r: { start: number; end: number; slotMinutes: number }) =>
  r.start < r.end && (r.end - r.start) % r.slotMinutes === 0;
const fitsSlotsMessage = {
  message: 'start < end, and the range is a whole number of slots',
};

export const scheduleRangeSchema = z
  .object({
    weekday: z.enum(WEEKDAYS),
    start: wallTimeSchema,
    end: wallTimeSchema,
    slotMinutes,
    serviceCodes,
  })
  .refine(fitsSlots, fitsSlotsMessage);
export type ScheduleRangeInput = z.input<typeof scheduleRangeSchema>;

/** The whole weekly schedule of a workplace, replacing the one before. Empty: closed. */
export const replaceScheduleSchema = z.object({
  ranges: z.array(scheduleRangeSchema).max(100),
  reason,
});
export type ReplaceSchedule = z.input<typeof replaceScheduleSchema>;

export const AVAILABILITY_EXCEPTION_KINDS = ['closed', 'extra', 'open_holiday'] as const;
export type AvailabilityExceptionKind = (typeof AVAILABILITY_EXCEPTION_KINDS)[number];

/**
 * An exception on one day. `closed`: leave, the whole day or a range of it, closing the
 * weekly schedule there. `extra`: hours added that day, open even on a holiday.
 * `open_holiday`: the weekly schedule applies on a holiday after all (doc 08 §6).
 */
export const createExceptionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('closed'),
      on: jalaliDaySchema,
      /** Both or neither; neither closes the whole day. */
      start: wallTimeSchema.optional(),
      end: wallTimeSchema.optional(),
      reason,
    })
    .refine(
      (e) =>
        (e.start === undefined && e.end === undefined) ||
        (e.start !== undefined && e.end !== undefined && e.start < e.end),
      { message: 'a closed range needs start < end, or neither for the whole day' },
    ),
  z
    .object({
      kind: z.literal('extra'),
      on: jalaliDaySchema,
      start: wallTimeSchema,
      end: wallTimeSchema,
      slotMinutes,
      serviceCodes,
      reason,
    })
    .refine(fitsSlots, fitsSlotsMessage),
  z.object({ kind: z.literal('open_holiday'), on: jalaliDaySchema, reason }),
]);
export type CreateException = z.input<typeof createExceptionSchema>;

export const removeExceptionSchema = z.object({ reason });

export const APPROVAL_MODES = ['auto', 'manual'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const setApprovalModeSchema = z.object({ mode: z.enum(APPROVAL_MODES), reason });
export type SetApprovalMode = z.input<typeof setApprovalModeSchema>;

/** Longest range of days one slot request may cover: two months. */
export const MAX_SLOT_RANGE_DAYS = 62;

/** From and to are Gregorian days (the Tehran day), YYYY-MM-DD, inclusive. */
export const slotQuerySchema = z.object({ from: z.iso.date(), to: z.iso.date() }).refine(
  (q) => {
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    return days >= 0 && days < MAX_SLOT_RANGE_DAYS;
  },
  { message: `from..to must cover 1..${String(MAX_SLOT_RANGE_DAYS)} days` },
);

// --- answers (task 2-11: the center panel's calendar) ------------------------------------

/** One range of the weekly schedule as the API gives it (wall times `HH:MM`). */
export const scheduleRangeViewSchema = z.object({
  weekday: z.enum(WEEKDAYS),
  start: z.string(),
  end: z.string(),
  slotMinutes: z.int(),
  serviceCodes: z.array(z.string()),
});
export const scheduleViewSchema = z.array(scheduleRangeViewSchema);

/** An exception on one Tehran day (`on`: its Gregorian date; pages show it in Jalali). */
export const exceptionViewSchema = z.object({
  id: z.uuid(),
  kind: z.enum(AVAILABILITY_EXCEPTION_KINDS),
  on: z.iso.date(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  slotMinutes: z.int().nullable(),
  serviceCodes: z.array(z.string()),
  reason: z.string(),
});

export const approvalModeViewSchema = z.object({
  mode: z.enum(APPROVAL_MODES),
  /** The workplace's own choice, or the configured default while it has made none. */
  source: z.enum(['workplace', 'default']),
  versionId: z.string(),
});

/** `GET /booking/workplaces/:id/calendar`. */
export const calendarViewSchema = z.object({
  workplaceId: z.uuid(),
  schedule: scheduleViewSchema,
  /** From today (Tehran) on, earliest first. */
  exceptions: z.array(exceptionViewSchema),
  approvalMode: approvalModeViewSchema,
});
export type CalendarViewBody = z.infer<typeof calendarViewSchema>;

/** `GET /booking/workplaces/:id/slots`: the free times, for the panel. */
export const slotViewListSchema = z.array(
  z.object({
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    serviceCodes: z.array(z.string()),
  }),
);

export const exceptionRemovedSchema = z.object({ removed: z.literal(true) });
