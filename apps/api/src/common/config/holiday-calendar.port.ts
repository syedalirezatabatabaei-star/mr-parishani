import type { WorkingCalendar } from '@sepehr/contracts';
import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the holiday calendar of the config module (task 2-1, doc 08 §5): the working-day
 * rules any module needs, loaded once for a range and then applied with the pure
 * isWorkingDay() / nextWorkingDay() of the contracts' Jalali wrapper. No module reads the
 * holidays table itself.
 */
export interface CalendarRequest {
  /** Gregorian days, YYYY-MM-DD, inclusive: the Tehran days the caller will ask about. */
  readonly from: string;
  readonly to: string;
  /** Null: national holidays only (installments, task 2-1 decision). */
  readonly cityCode: string | null;
  /** The weekly days off in effect at this moment (rule 16); default now. */
  readonly at?: Date;
}

export interface LoadedCalendar {
  readonly calendar: WorkingCalendar;
  /** The calendar.weekly_days_off version used: store it on the record it decided. */
  readonly weeklyDaysOffVersionId: string;
}

export interface HolidayCalendarPort {
  calendarFor(request: CalendarRequest, tx?: SqlExecutor): Promise<LoadedCalendar>;
}

export const HOLIDAY_CALENDAR = Symbol('HOLIDAY_CALENDAR');
