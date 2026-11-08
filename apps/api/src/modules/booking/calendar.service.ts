import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  formatWallTime,
  gregorianDayOf,
  gregorianToJalali,
  toJalali,
  weekdayOf,
  WEEKDAYS,
  type ApprovalMode,
  type createExceptionSchema,
  type PermissionCode,
  type replaceScheduleSchema,
  type setApprovalModeSchema,
  type Weekday,
} from '@sepehr/contracts';
import { and, asc, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
  type WorkplaceRecord,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import {
  availabilityExceptions,
  scheduleTemplates,
  workplaceApprovalModes,
} from './booking.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type TemplateRow = typeof scheduleTemplates.$inferSelect;
type ExceptionRow = typeof availabilityExceptions.$inferSelect;

const READ: PermissionCode = 'booking.read_calendar';
const MANAGE_OWN: PermissionCode = 'booking.manage_own_calendar';
const MANAGE_IN_SCOPE: PermissionCode = 'booking.manage_calendar_in_scope';
const MANAGE_ANY: PermissionCode = 'booking.manage_any_calendar';
const MANAGE_APPROVAL: PermissionCode = 'booking.manage_approval_mode';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScheduleRangeView {
  readonly weekday: Weekday;
  readonly start: string;
  readonly end: string;
  readonly slotMinutes: number;
  readonly serviceCodes: string[];
}

export interface ExceptionView {
  readonly id: string;
  readonly kind: ExceptionRow['kind'];
  /** The Tehran day as its Gregorian date, YYYY-MM-DD; the panel shows it in Jalali. */
  readonly on: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly slotMinutes: number | null;
  readonly serviceCodes: string[];
  readonly reason: string;
}

export interface ApprovalModeView {
  readonly mode: ApprovalMode;
  /** The workplace's own choice, or the configured default while it has made none. */
  readonly source: 'workplace' | 'default';
  /** What an appointment locks (rule 16): the workplace row, or the config version. */
  readonly versionId: string;
}

export interface CalendarView {
  readonly workplaceId: string;
  readonly schedule: ScheduleRangeView[];
  /** From today (Tehran) on, earliest first. */
  readonly exceptions: ExceptionView[];
  readonly approvalMode: ApprovalModeView;
}

const rangeView = (row: TemplateRow): ScheduleRangeView => ({
  weekday: row.weekday,
  start: formatWallTime(row.startMinute),
  end: formatWallTime(row.endMinute),
  slotMinutes: row.slotMinutes,
  serviceCodes: row.serviceCodes,
});

const exceptionView = (row: ExceptionRow): ExceptionView => ({
  id: row.id,
  kind: row.kind,
  on: row.onDay,
  start: row.startMinute === null ? null : formatWallTime(row.startMinute),
  end: row.endMinute === null ? null : formatWallTime(row.endMinute),
  slotMinutes: row.slotMinutes,
  serviceCodes: row.serviceCodes,
  reason: row.reason,
});

const within = (path: string, by: string) => path === by || path.startsWith(`${by}.`);
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd && bStart < aEnd;

const weekdayOfDay = (day: string): Weekday => {
  const [year, month, date] = day.split('-').map(Number);
  return weekdayOf(gregorianToJalali({ year: year ?? 0, month: month ?? 0, day: date ?? 0 }));
};

/** Today in Tehran, YYYY-MM-DD: exceptions are for today and later only. */
const tehranToday = () => gregorianDayOf(toJalali(new Date()));

const pgCode = (error: unknown): string | undefined => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
};

/** The same message whichever place the doctor is busy at: it is never named (decision 4). */
const busyElsewhere = () => new ConflictException({ error: 'doctor_busy_elsewhere' });

/**
 * A doctor's calendar at each workplace (task 2-5, doc 08 §6, ADR-025): the weekly
 * schedule, the exceptions on given days, and whether appointments there are approved
 * automatically or by the center.
 *
 * Who may change a calendar (task 2-5 decisions), each a permission the service matches to
 * the workplace on every request (rules 12 and 13), never a role:
 * - booking.manage_own_calendar: the doctor with an account, at their own workplace, or
 *   that workplace's secretary it was delegated to (by the doctor, or for a doctor without
 *   an account by the manager above).
 * - booking.manage_calendar_in_scope: a center or branch scope covering the workplace.
 * - booking.manage_any_calendar: Sepehr's operators, by a global or city scope.
 * The approval mode (booking.manage_approval_mode) is the doctor with an account, a center
 * or branch manager in scope, or an operator; never a secretary. A workplace out of the
 * caller's scope does not exist (404). Everything anyone but the doctor does is audited on
 * the doctor's behalf, with the state before and after.
 */
@Injectable()
export class CalendarService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(WORKPLACE_DIRECTORY) private readonly directory: WorkplaceDirectory,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  // --- reading ------------------------------------------------------------------------

  async calendar(access: EffectiveAccess, workplaceId: string): Promise<CalendarView> {
    this.require(access, [READ]);
    const workplace = await this.visibleWorkplace(this.db, access, workplaceId);
    const [schedule, exceptions, approvalMode] = await Promise.all([
      this.liveRanges(this.db, workplace.id),
      this.db
        .select()
        .from(availabilityExceptions)
        .where(
          and(
            eq(availabilityExceptions.workplaceId, workplace.id),
            isNull(availabilityExceptions.deletedAt),
            gte(availabilityExceptions.onDay, tehranToday()),
          ),
        )
        .orderBy(asc(availabilityExceptions.onDay), asc(availabilityExceptions.startMinute)),
      this.approvalModeOf(workplace.id),
    ]);
    return {
      workplaceId: workplace.id,
      schedule: schedule.map(rangeView),
      exceptions: exceptions.map(exceptionView),
      approvalMode,
    };
  }

  /** The mode in force: the workplace's latest choice, else the configured default. */
  async approvalModeOf(workplaceId: string): Promise<ApprovalModeView> {
    const [row] = await this.db
      .select()
      .from(workplaceApprovalModes)
      .where(eq(workplaceApprovalModes.workplaceId, workplaceId))
      .orderBy(desc(workplaceApprovalModes.createdAt), desc(workplaceApprovalModes.id))
      .limit(1);
    if (row) return { mode: row.mode, source: 'workplace', versionId: row.id };
    const fallback = await this.config.resolve('booking.default_approval_mode');
    return { mode: fallback.value, source: 'default', versionId: fallback.versionId };
  }

  // --- the weekly schedule --------------------------------------------------------------

  /** Replaces the whole weekly schedule of a workplace; an empty list closes it. */
  async replaceSchedule(
    actor: Actor,
    access: EffectiveAccess,
    workplaceId: string,
    input: z.output<typeof replaceScheduleSchema>,
  ): Promise<ScheduleRangeView[]> {
    this.require(access, [MANAGE_OWN, MANAGE_IN_SCOPE, MANAGE_ANY]);
    return this.db.transaction(async (tx) => {
      const { workplace, auditActor } = await this.managedWorkplace(tx, actor, access, workplaceId);
      await this.requireOfferable(
        tx,
        workplace.id,
        input.ranges.flatMap((r) => r.serviceCodes),
      );
      input.ranges.forEach((a, i) => {
        const clash = input.ranges.some(
          (b, j) => j > i && a.weekday === b.weekday && overlaps(a.start, a.end, b.start, b.end),
        );
        if (clash) throw new BadRequestException({ error: 'schedule_overlap' });
      });

      // The doctor's other workplaces: their weekly ranges, and their extra hours from today.
      const elsewhere = await tx
        .select()
        .from(scheduleTemplates)
        .where(
          and(
            eq(scheduleTemplates.doctorId, workplace.doctorId),
            ne(scheduleTemplates.workplaceId, workplace.id),
            isNull(scheduleTemplates.deletedAt),
          ),
        );
      const extraElsewhere = await this.extrasElsewhere(tx, workplace, tehranToday());
      for (const r of input.ranges) {
        const busy =
          elsewhere.some(
            (o) => o.weekday === r.weekday && overlaps(r.start, r.end, o.startMinute, o.endMinute),
          ) ||
          extraElsewhere.some(
            (o) =>
              weekdayOfDay(o.onDay) === r.weekday &&
              overlaps(r.start, r.end, o.startMinute ?? 0, o.endMinute ?? 0),
          );
        if (busy) throw busyElsewhere();
      }

      const before = await this.liveRanges(tx, workplace.id);
      if (before.length > 0) {
        await tx
          .update(scheduleTemplates)
          .set({ deletedAt: new Date(), deletedBy: actor.accountId })
          .where(
            and(
              eq(scheduleTemplates.workplaceId, workplace.id),
              isNull(scheduleTemplates.deletedAt),
            ),
          );
      }
      let after: TemplateRow[] = [];
      if (input.ranges.length > 0) {
        after = await this.guardOverlap(() =>
          tx
            .insert(scheduleTemplates)
            .values(
              input.ranges.map((r) => ({
                workplaceId: workplace.id,
                doctorId: workplace.doctorId,
                weekday: r.weekday,
                startMinute: r.start,
                endMinute: r.end,
                slotMinutes: r.slotMinutes,
                serviceCodes: r.serviceCodes,
                createdBy: actor.accountId,
              })),
            )
            .returning(),
        );
      }
      const sorted = this.sortRanges(after);
      await this.announce(tx, workplace.id, workplace.doctorId);
      await this.audit.record(
        {
          actor: auditActor,
          action: 'booking.schedule_replaced',
          entityType: 'workplace_schedule',
          entityId: workplace.id,
          before: this.sortRanges(before).map(rangeView),
          after: sorted.map(rangeView),
          reason: input.reason,
        },
        tx,
      );
      return sorted.map(rangeView);
    });
  }

  // --- exceptions -----------------------------------------------------------------------

  async addException(
    actor: Actor,
    access: EffectiveAccess,
    workplaceId: string,
    input: z.output<typeof createExceptionSchema>,
  ): Promise<ExceptionView> {
    this.require(access, [MANAGE_OWN, MANAGE_IN_SCOPE, MANAGE_ANY]);
    const onDay = gregorianDayOf(input.on);
    if (onDay < tehranToday()) throw new BadRequestException({ error: 'day_in_past' });
    return this.db.transaction(async (tx) => {
      const { workplace, auditActor } = await this.managedWorkplace(tx, actor, access, workplaceId);
      if (input.kind === 'extra') {
        await this.requireOfferable(tx, workplace.id, input.serviceCodes);
        await this.requireFreeForExtra(tx, workplace, onDay, input.start, input.end);
      }
      const values = {
        workplaceId: workplace.id,
        doctorId: workplace.doctorId,
        onDay,
        kind: input.kind,
        startMinute: input.kind === 'open_holiday' ? null : (input.start ?? null),
        endMinute: input.kind === 'open_holiday' ? null : (input.end ?? null),
        slotMinutes: input.kind === 'extra' ? input.slotMinutes : null,
        serviceCodes: input.kind === 'extra' ? input.serviceCodes : [],
        reason: input.reason,
        createdBy: actor.accountId,
      };
      const [row] = await this.guardOverlap(async () => {
        try {
          return await tx.insert(availabilityExceptions).values(values).returning();
        } catch (error) {
          if (pgCode(error) === '23505') throw new ConflictException({ error: 'exception_exists' });
          throw error;
        }
      });
      if (!row) throw new Error('exception not inserted');
      await this.announce(tx, workplace.id, workplace.doctorId);
      await this.audit.record(
        {
          actor: auditActor,
          action: 'booking.exception_added',
          entityType: 'availability_exception',
          entityId: row.id,
          after: { workplaceId: workplace.id, ...exceptionView(row) },
          reason: input.reason,
        },
        tx,
      );
      return exceptionView(row);
    });
  }

  /** Removes an exception of today or later (soft delete, rule 7). */
  async removeException(
    actor: Actor,
    access: EffectiveAccess,
    exceptionId: string,
    reason: string,
  ): Promise<void> {
    this.require(access, [MANAGE_OWN, MANAGE_IN_SCOPE, MANAGE_ANY]);
    if (!UUID.test(exceptionId)) throw new NotFoundException({ error: 'exception_not_found' });
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(availabilityExceptions)
        .where(
          and(eq(availabilityExceptions.id, exceptionId), isNull(availabilityExceptions.deletedAt)),
        );
      if (!row) throw new NotFoundException({ error: 'exception_not_found' });
      const { auditActor } = await this.managedWorkplace(tx, actor, access, row.workplaceId).catch(
        (error: unknown) => {
          throw error instanceof NotFoundException
            ? new NotFoundException({ error: 'exception_not_found' })
            : error;
        },
      );
      if (row.onDay < tehranToday()) throw new ConflictException({ error: 'day_in_past' });
      await tx
        .update(availabilityExceptions)
        .set({ deletedAt: new Date(), deletedBy: actor.accountId })
        .where(eq(availabilityExceptions.id, row.id));
      await this.announce(tx, row.workplaceId, row.doctorId);
      await this.audit.record(
        {
          actor: auditActor,
          action: 'booking.exception_removed',
          entityType: 'availability_exception',
          entityId: row.id,
          before: { workplaceId: row.workplaceId, ...exceptionView(row) },
          reason,
        },
        tx,
      );
    });
  }

  /** The slots of this workplace changed: the public search re-indexes it (task 2-7). */
  private announce(tx: Tx, workplaceId: string, doctorId: string) {
    return this.outbox.publish(
      {
        type: 'booking.calendar_changed',
        aggregateType: 'workplace',
        aggregateId: workplaceId,
        payload: { workplaceId, doctorId },
      },
      tx,
    );
  }

  // --- approval mode ----------------------------------------------------------------------

  /**
   * Only new appointments follow a change (task 2-6 decision 1): each request keeps the
   * mode it was made with, so switching to automatic confirms nothing already waiting and
   * the panel warns of those (AppointmentService.pendingManual). TODO(decision): the
   * client's confirmation (doc 09 open item 11).
   */
  async setApprovalMode(
    actor: Actor,
    access: EffectiveAccess,
    workplaceId: string,
    input: z.output<typeof setApprovalModeSchema>,
  ): Promise<ApprovalModeView> {
    this.require(access, [MANAGE_APPROVAL]);
    return this.db.transaction(async (tx) => {
      const workplace = await this.visibleWorkplace(tx, access, workplaceId);
      await this.lockDoctor(tx, workplace.doctorId);
      if (
        actor.accountId !== null &&
        (await this.directory.isSecretary(workplace.id, actor.accountId, tx))
      ) {
        throw new ForbiddenException({ error: 'secretary_not_allowed' });
      }
      const isDoctor =
        workplace.doctorAccountId !== null && workplace.doctorAccountId === actor.accountId;
      const allowed =
        isDoctor ||
        access.scopes.some(
          (scope) =>
            scope.kind === 'global' ||
            (scope.kind === 'city' && scope.code === workplace.cityCode) ||
            ((scope.kind === 'center' || scope.kind === 'branch') &&
              within(workplace.nodePath, scope.path)),
        );
      if (!allowed) throw new ForbiddenException({ error: 'approval_mode_managers_only' });
      this.requireNotFrozen(workplace);
      const before = await this.approvalModeOf(workplace.id);
      const [row] = await tx
        .insert(workplaceApprovalModes)
        .values({
          workplaceId: workplace.id,
          mode: input.mode,
          reason: input.reason,
          createdBy: actor.accountId,
        })
        .returning();
      if (!row) throw new Error('approval mode not inserted');
      const after: ApprovalModeView = { mode: row.mode, source: 'workplace', versionId: row.id };
      await this.audit.record(
        {
          actor: isDoctor ? actor : { ...actor, onBehalfOfDoctorId: workplace.doctorId },
          action: 'booking.approval_mode_set',
          entityType: 'workplace_approval_mode',
          entityId: workplace.id,
          before,
          after,
          reason: input.reason,
        },
        tx,
      );
      return after;
    });
  }

  // --- helpers ----------------------------------------------------------------------------

  /** Rule 12: checked here as well as by the guard. */
  private require(access: EffectiveAccess, anyOf: PermissionCode[]) {
    if (!anyOf.some((code) => access.permissions.has(code))) {
      throw new ForbiddenException({ error: 'permission_required', permission: anyOf[0] });
    }
  }

  /** The workplace if the caller's scope covers it; otherwise it does not exist (rule 13). */
  async visibleWorkplace(
    ex: Tx | Database,
    access: EffectiveAccess,
    workplaceId: string,
  ): Promise<WorkplaceRecord> {
    const workplace = await this.directory.workplace(workplaceId, ex);
    const covers =
      workplace !== null &&
      access.scopes.some((scope) => {
        if (scope.kind === 'global') return true;
        if (scope.kind === 'city') return scope.code === workplace.cityCode;
        if (scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') {
          return within(workplace.nodePath, scope.path);
        }
        return false;
      });
    if (!workplace || !covers) throw new NotFoundException({ error: 'workplace_not_found' });
    return workplace;
  }

  /**
   * The workplace if the caller may change its calendar through one of the three calendar
   * permissions, with the doctor's calendar locked for this transaction; and the audit
   * actor, «on behalf of» the doctor unless the doctor acts.
   */
  private async managedWorkplace(
    tx: Tx,
    actor: Actor,
    access: EffectiveAccess,
    workplaceId: string,
  ): Promise<{ workplace: WorkplaceRecord; auditActor: Actor }> {
    const workplace = await this.visibleWorkplace(tx, access, workplaceId);
    await this.lockDoctor(tx, workplace.doctorId);
    const isDoctor =
      workplace.doctorAccountId !== null && workplace.doctorAccountId === actor.accountId;
    const any =
      access.permissions.has(MANAGE_ANY) &&
      access.scopes.some(
        (scope) =>
          scope.kind === 'global' || (scope.kind === 'city' && scope.code === workplace.cityCode),
      );
    const inScope =
      access.permissions.has(MANAGE_IN_SCOPE) &&
      access.scopes.some(
        (scope) =>
          (scope.kind === 'center' || scope.kind === 'branch') &&
          within(workplace.nodePath, scope.path),
      );
    const own =
      access.permissions.has(MANAGE_OWN) &&
      (isDoctor ||
        (actor.accountId !== null &&
          (await this.directory.isSecretary(workplace.id, actor.accountId, tx))));
    if (!any && !inScope && !own) throw new ForbiddenException({ error: 'calendar_managers_only' });
    this.requireNotFrozen(workplace);
    return {
      workplace,
      auditActor: isDoctor ? actor : { ...actor, onBehalfOfDoctorId: workplace.doctorId },
    };
  }

  /** A terminated center is frozen (ADR-022); a suspended one keeps its calendar. */
  private requireNotFrozen(workplace: WorkplaceRecord) {
    if (workplace.centerStatus === 'terminated') {
      throw new ConflictException({ error: 'center_terminated' });
    }
  }

  /**
   * One change to one doctor's calendars at a time, whichever workplace: the overlap checks
   * across workplaces read what the other transactions would write.
   */
  private async lockDoctor(tx: Tx, doctorId: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`booking.doctor:${doctorId}`}, 0))`,
    );
  }

  private async requireOfferable(tx: Tx, workplaceId: string, codes: readonly string[]) {
    if (codes.length === 0) return;
    const offerable = new Set(await this.directory.offerableServiceCodes(workplaceId, tx));
    const unknown = [...new Set(codes)].filter((code) => !offerable.has(code));
    if (unknown.length > 0) {
      throw new BadRequestException({ error: 'service_not_offered', serviceCodes: unknown });
    }
  }

  /**
   * Extra hours must not meet the weekly schedule of that day here (unless closed then),
   * nor any time of the doctor's elsewhere, whose place is never named.
   */
  private async requireFreeForExtra(
    tx: Tx,
    workplace: WorkplaceRecord,
    onDay: string,
    start: number,
    end: number,
  ) {
    const weekday = weekdayOfDay(onDay);
    const templates = await tx
      .select()
      .from(scheduleTemplates)
      .where(
        and(
          eq(scheduleTemplates.doctorId, workplace.doctorId),
          eq(scheduleTemplates.weekday, weekday),
          isNull(scheduleTemplates.deletedAt),
        ),
      );
    const sameDay = await tx
      .select()
      .from(availabilityExceptions)
      .where(
        and(
          eq(availabilityExceptions.doctorId, workplace.doctorId),
          eq(availabilityExceptions.onDay, onDay),
          isNull(availabilityExceptions.deletedAt),
        ),
      );
    const closedHere = sameDay.filter((e) => e.kind === 'closed' && e.workplaceId === workplace.id);
    for (const t of templates) {
      if (!overlaps(start, end, t.startMinute, t.endMinute)) continue;
      if (t.workplaceId !== workplace.id) throw busyElsewhere();
      // The part of the weekly range this extra meets must be closed that day.
      let open = [[Math.max(start, t.startMinute), Math.min(end, t.endMinute)] as const];
      for (const c of closedHere) {
        const [cs, ce] = [c.startMinute ?? 0, c.endMinute ?? 1440];
        open = open.flatMap(([s, e]) =>
          [[s, Math.min(e, cs)] as const, [Math.max(s, ce), e] as const].filter(([a, b]) => a < b),
        );
      }
      if (open.length > 0) throw new BadRequestException({ error: 'schedule_overlap' });
    }
    for (const e of sameDay) {
      if (e.kind !== 'extra' || !overlaps(start, end, e.startMinute ?? 0, e.endMinute ?? 0)) {
        continue;
      }
      if (e.workplaceId !== workplace.id) throw busyElsewhere();
      throw new BadRequestException({ error: 'schedule_overlap' });
    }
  }

  private extrasElsewhere(tx: Tx, workplace: WorkplaceRecord, fromDay: string) {
    return tx
      .select()
      .from(availabilityExceptions)
      .where(
        and(
          eq(availabilityExceptions.doctorId, workplace.doctorId),
          ne(availabilityExceptions.workplaceId, workplace.id),
          eq(availabilityExceptions.kind, 'extra'),
          gte(availabilityExceptions.onDay, fromDay),
          isNull(availabilityExceptions.deletedAt),
        ),
      );
  }

  /** The database's exclusion constraints back the checks above (a race, a bug). */
  private async guardOverlap<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (pgCode(error) === '23P01') throw busyElsewhere();
      throw error;
    }
  }

  liveRanges(ex: Tx | Database, workplaceId: string): Promise<TemplateRow[]> {
    return ex
      .select()
      .from(scheduleTemplates)
      .where(
        and(eq(scheduleTemplates.workplaceId, workplaceId), isNull(scheduleTemplates.deletedAt)),
      )
      .then((rows) => this.sortRanges(rows));
  }

  private sortRanges(rows: TemplateRow[]): TemplateRow[] {
    return [...rows].sort(
      (a, b) =>
        WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday) || a.startMinute - b.startMinute,
    );
  }
}
