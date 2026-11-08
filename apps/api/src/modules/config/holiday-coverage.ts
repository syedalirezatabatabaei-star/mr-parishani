import { Inject, Injectable, Logger } from '@nestjs/common';
import { gregorianDayOf, jalaliMonthLength, toJalali, toPersianDigits } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../db/database.module';

export const HOLIDAYS_MISSING_NOTICE = 'holidays_missing';

/** From 1 Bahman the next year's holidays are due (doc 08 §5). */
const BAHMAN = 11;
/** A notice still open is raised again this often (task 2-1 decision: weekly). */
const REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

export interface CoverageResult {
  /** Jalali years with no national holiday entered, among those checked. */
  readonly missingYears: readonly number[];
  readonly notice: 'raised' | 'open' | 'resolved' | 'none';
}

/**
 * Checks that the holiday calendar is filled in (task 2-1, doc 08 §5). Every year the
 * lunar holidays of the next year must be entered; from 1 Bahman, while the next Jalali
 * year (or, worse, the current one) has no national holiday, an in-panel notice for the
 * system admin is open and a warning is logged, repeated weekly until they are entered
 * (task 2-1 decision: not an on-call SMS). The worker runs it daily, so it starts on
 * 1 Bahman itself; it resolves the notice once the missing years are filled in.
 */
@Injectable()
export class HolidayCoverageCheck {
  private readonly logger = new Logger(HolidayCoverageCheck.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async run(now = new Date()): Promise<CoverageResult> {
    const today = toJalali(now);
    const years = today.month >= BAHMAN ? [today.year, today.year + 1] : [today.year];
    const missingYears: number[] = [];
    for (const year of years) {
      if (!(await this.hasNationalHoliday(year))) missingYears.push(year);
    }

    return this.db.transaction(async (tx) => {
      const open = await tx.execute<{ id: string; last_raised_at: Date }>(sql`
        SELECT id, last_raised_at FROM admin_notices
        WHERE code = ${HOLIDAYS_MISSING_NOTICE} AND resolved_at IS NULL AND deleted_at IS NULL
        FOR UPDATE
      `);
      const notice = open.rows[0];
      if (missingYears.length === 0) {
        if (!notice) return { missingYears, notice: 'none' as const };
        await tx.execute(
          sql`UPDATE admin_notices SET resolved_at = ${now} WHERE id = ${notice.id}`,
        );
        this.logger.log('holiday calendar: notice resolved, holidays entered');
        return { missingYears, notice: 'resolved' as const };
      }

      // Shown in the panel: Jalali years in Persian digits (ADR-011).
      const message = `تعطیلات رسمی سال ${missingYears.map((y) => toPersianDigits(y)).join(' و ')} در تقویم تعطیلات ثبت نشده است.`;
      if (notice && now.getTime() - new Date(notice.last_raised_at).getTime() < REPEAT_MS) {
        return { missingYears, notice: 'open' as const };
      }
      if (notice) {
        await tx.execute(sql`
          UPDATE admin_notices
          SET last_raised_at = ${now}, raise_count = raise_count + 1, message = ${message}
          WHERE id = ${notice.id}
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO admin_notices (code, audience_permission, message, first_raised_at, last_raised_at)
          VALUES (${HOLIDAYS_MISSING_NOTICE}, 'config.manage_holidays', ${message}, ${now}, ${now})
        `);
      }
      this.logger.warn(
        `holiday calendar: no national holiday entered for year(s) ${missingYears.join(', ')}`,
      );
      return { missingYears, notice: 'raised' as const };
    });
  }

  private async hasNationalHoliday(year: number): Promise<boolean> {
    const from = gregorianDayOf({ year, month: 1, day: 1 });
    const to = gregorianDayOf({ year, month: 12, day: jalaliMonthLength(year, 12) });
    const rows = await this.db.execute(sql`
      SELECT 1 FROM holidays
      WHERE kind = 'national' AND deleted_at IS NULL
        AND holiday_on BETWEEN ${from}::date AND ${to}::date
      LIMIT 1
    `);
    return rows.rows.length > 0;
  }
}
