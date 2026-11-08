import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  gregorianDayOf,
  type CalendarHoliday,
  type createHolidaySchema,
  type holidayQuerySchema,
  type PermissionCode,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import type {
  CalendarRequest,
  HolidayCalendarPort,
  LoadedCalendar,
} from '../../common/config/holiday-calendar.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';

const MANAGE: PermissionCode = 'config.manage_holidays';

export interface HolidayView {
  readonly id: string;
  /** Gregorian YYYY-MM-DD of the Tehran day; the client shows it in Jalali (rule 21). */
  readonly on: string;
  readonly title: string;
  readonly kind: 'national' | 'city';
  readonly cityCode: string | null;
}

export interface AdminNoticeView {
  readonly id: string;
  readonly code: string;
  readonly message: string;
  readonly firstRaisedAt: string;
  readonly lastRaisedAt: string;
  readonly raiseCount: number;
}

interface HolidayRow extends Record<string, unknown> {
  id: string;
  on: string;
  title: string;
  kind: 'national' | 'city';
  city_code: string | null;
}

const view = (row: HolidayRow): HolidayView => ({
  id: row.id,
  on: row.on,
  title: row.title,
  kind: row.kind,
  cityCode: row.city_code,
});

const HOLIDAY_COLUMNS = sql`id, to_char(holiday_on, 'YYYY-MM-DD') AS "on", title, kind, city_code`;

/**
 * The holiday calendar (task 2-1, doc 08 §5, ADR-021): national and city holidays,
 * managed from the panel by the system admin (config.manage_holidays; one person, every
 * change audited, task 2-1 decision) and read by every module through the
 * HOLIDAY_CALENDAR port. A holiday is never edited: a wrong one is removed (soft delete,
 * rule 7) and entered again.
 */
@Injectable()
export class HolidayService implements HolidayCalendarPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async calendarFor(request: CalendarRequest, tx?: SqlExecutor): Promise<LoadedCalendar> {
    const weekly = await this.config.resolve('calendar.weekly_days_off', {}, request.at);
    const holidays = await this.rows(request, tx ?? this.db);
    return {
      calendar: {
        weeklyDaysOff: weekly.value,
        holidays: holidays.map((h): CalendarHoliday => ({ on: h.on, cityCode: h.city_code })),
      },
      weeklyDaysOffVersionId: weekly.versionId,
    };
  }

  /** National holidays and, with a city, that city's; public (doc 08: shown in booking). */
  async list(query: z.output<typeof holidayQuerySchema>): Promise<HolidayView[]> {
    const rows = await this.rows(
      { from: query.from, to: query.to, cityCode: query.cityCode ?? null },
      this.db,
    );
    return rows.map(view);
  }

  /**
   * One holiday added inside the caller's transaction (owner 1405/07/27: only a batch's
   * approval adds one), announced and audited. A day already there is refused (`holiday_exists`, with the day), never written
   * over, so the caller's transaction rolls back (plan 3: a batch is all or none). The caller
   * has checked the permission.
   */
  async addInTransaction(
    tx: SqlExecutor,
    actor: Actor,
    input: z.output<typeof createHolidaySchema>,
  ): Promise<HolidayView> {
    const on = gregorianDayOf(input.on);
    const cityCode = input.cityCode ?? null;
    const created = await tx.execute(sql`
      INSERT INTO holidays (holiday_on, title, kind, city_code, created_by)
      VALUES (${on}::date, ${input.title}, ${cityCode === null ? 'national' : 'city'},
              ${cityCode}, ${actor.accountId})
      ON CONFLICT DO NOTHING
      RETURNING ${HOLIDAY_COLUMNS}
    `);
    const row = created.rows[0] as HolidayRow | undefined;
    if (!row) throw new ConflictException({ error: 'holiday_exists', on });
    await this.announce(tx, row);
    await this.audit.record(
      {
        actor,
        action: 'config.holiday_added',
        entityType: 'holiday',
        entityId: row.id,
        after: view(row),
        reason: input.reason,
      },
      tx,
    );
    return view(row);
  }

  /** A holiday on the calendar now (not removed), or null. */
  async current(id: string, tx: SqlExecutor = this.db): Promise<HolidayView | null> {
    const found = await tx.execute(sql`
      SELECT ${HOLIDAY_COLUMNS} FROM holidays WHERE id = ${id} AND deleted_at IS NULL
    `);
    const row = found.rows[0] as HolidayRow | undefined;
    return row ? view(row) : null;
  }

  /**
   * One holiday removed inside the caller's transaction (owner 1405/07/29: only a removal's
   * approval removes one): a soft delete (rule 7), announced and audited. A holiday already
   * removed is refused (`holiday_not_found`). The caller has checked the permission.
   */
  async removeInTransaction(
    tx: SqlExecutor,
    actor: Actor,
    id: string,
    reason: string,
  ): Promise<HolidayView> {
    const removed = await tx.execute(sql`
      UPDATE holidays SET deleted_at = now(), deleted_by = ${actor.accountId}
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING ${HOLIDAY_COLUMNS}
    `);
    const row = removed.rows[0] as HolidayRow | undefined;
    if (!row) throw new NotFoundException({ error: 'holiday_not_found' });
    await this.announce(tx, row);
    await this.audit.record(
      {
        actor,
        action: 'config.holiday_removed',
        entityType: 'holiday',
        entityId: row.id,
        before: view(row),
        reason,
      },
      tx,
    );
    return view(row);
  }

  /** Slots of the workplaces this holiday covers change: the public search re-indexes them. */
  private announce(tx: SqlExecutor, row: HolidayRow) {
    return this.outbox.publish(
      {
        type: 'config.holidays_changed',
        aggregateType: 'holiday',
        aggregateId: row.id,
        payload: { holidayId: row.id, cityCode: row.city_code },
      },
      tx,
    );
  }

  /** Open notices addressed to a permission the caller holds (task 2-1: shown in the panel). */
  async notices(access: EffectiveAccess): Promise<AdminNoticeView[]> {
    const permissions = [...access.permissions];
    if (permissions.length === 0) return [];
    const rows = await this.db.execute(sql`
      SELECT id, code, message, raise_count,
             to_char(first_raised_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_raised_at,
             to_char(last_raised_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_raised_at
      FROM admin_notices
      WHERE resolved_at IS NULL AND deleted_at IS NULL
        AND audience_permission IN (${sql.join(
          permissions.map((p) => sql`${p}`),
          sql`, `,
        )})
      ORDER BY first_raised_at
    `);
    return rows.rows.map((r) => ({
      id: r['id'] as string,
      code: r['code'] as string,
      message: r['message'] as string,
      firstRaisedAt: r['first_raised_at'] as string,
      lastRaisedAt: r['last_raised_at'] as string,
      raiseCount: r['raise_count'] as number,
    }));
  }

  private async rows(
    request: Pick<CalendarRequest, 'from' | 'to' | 'cityCode'>,
    ex: SqlExecutor,
  ): Promise<HolidayRow[]> {
    if (request.to < request.from) throw new BadRequestException({ error: 'invalid_range' });
    const result = await ex.execute(sql`
      SELECT ${HOLIDAY_COLUMNS} FROM holidays
      WHERE deleted_at IS NULL
        AND holiday_on BETWEEN ${request.from}::date AND ${request.to}::date
        AND (city_code IS NULL OR city_code = ${request.cityCode})
      ORDER BY holiday_on, city_code NULLS FIRST
    `);
    return result.rows as HolidayRow[];
  }

  /** Rule 12: checked here as well as by the guard. */
  private assertMayManage(access: EffectiveAccess) {
    if (!access.permissions.has(MANAGE)) {
      throw new ForbiddenException({ error: 'permission_required', permission: MANAGE });
    }
  }
}
