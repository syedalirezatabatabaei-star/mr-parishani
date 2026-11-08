import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
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
  toJalali,
  type createHolidayBatchSchema,
  type HolidayBatchView,
  type PermissionCode,
} from '@sepehr/contracts';
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { holidayBatches } from './config.schema';
import { HolidaySuggestionService } from './holiday-suggestion.service';
import { HolidayService } from './holiday.service';

const MANAGE: PermissionCode = 'config.manage_holidays';
/** Owner 1405/08/02: the CEO's deputy decides what another asked for, and asks for nothing. */
const APPROVE: PermissionCode = 'config.approve_holidays';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = typeof holidayBatches.$inferSelect;
interface BatchDay {
  readonly on: string;
  readonly title: string;
  /** Owner 1405/07/27: a city's holiday; absent in batches before it (national). */
  readonly cityCode?: string | null;
}

/**
 * Holidays saved together (owner 1405/07/24, plan 3; ADR-043; migration 0089). One holder of
 * config.manage_holidays asks with the days of one Jalali year and a reason; a second holder,
 * never the asker, approves or rejects (maker-checker, as a sensitive configuration change;
 * the database holds the rule too). Before either, both see how many contracts not yet funded
 * print a due day on one of the days (plan 3 (a)): when asked, stored, and again, fresh, while
 * it waits.
 *
 * Approving adds every day in one transaction, each as a typed holiday is added (announced and
 * audited with the batch's reason), or none: a day already in the calendar, then or since, is
 * refused (`holiday_exists`) and nothing is saved. An existing holiday is never written over.
 * Asking and deciding need a TOTP code given again in the session (R1).
 */
@Injectable()
export class HolidayBatchService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    private readonly holidays: HolidayService,
    private readonly suggestions: HolidaySuggestionService,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async request(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof createHolidayBatchSchema>,
    now = new Date(),
  ): Promise<HolidayBatchView> {
    assertMayManage(access);
    await assertFreshMfa(this.config, actor, now);
    const requestedBy = actor.accountId;
    // ADR-052: holidays move due days; the asker signs with their own SMS code.
    if (requestedBy !== null) {
      await this.stepUp.assert(actor, {
        type: 'holidays',
        id: requestedBy,
        amountRial: null,
        step: 'request',
      });
    }
    if (requestedBy === null) throw new ForbiddenException();
    const days: BatchDay[] = input.days
      .map((d) => ({ on: gregorianDayOf(d.on), title: d.title, cityCode: d.cityCode ?? null }))
      .sort((a, b) => a.on.localeCompare(b.on));
    const entered = await this.suggestions.nationalDaysOf(input.year);
    const taken = days.find((d) => d.cityCode === null && entered.has(d.on));
    if (taken) throw new ConflictException({ error: 'holiday_exists', on: taken.on });
    // A due day moves only for a national holiday (ADR-021): only those are counted.
    const affectedContracts = await this.suggestions.affectedContracts(national(days));

    const row = await this.db
      .transaction(async (tx) => {
        const [made] = await tx
          .insert(holidayBatches)
          .values({ year: input.year, days, reason: input.reason, requestedBy, affectedContracts })
          .returning();
        if (!made) throw new Error('holiday batch insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'config.holiday_batch_requested',
            entityType: 'holiday_batch',
            entityId: made.id,
            after: { year: input.year, days: days.length, affectedContracts },
            reason: input.reason,
          },
          tx,
        );
        return made;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'batch_open' });
        throw error;
      });
    return this.view(row, requestedBy);
  }

  /** The batches waiting for a second person, newest first, each with its count now. */
  async pending(access: EffectiveAccess): Promise<HolidayBatchView[]> {
    assertMayDecide(access);
    const rows = await this.db
      .select()
      .from(holidayBatches)
      .where(eq(holidayBatches.status, 'pending'))
      .orderBy(desc(holidayBatches.createdAt))
      .limit(50);
    return Promise.all(rows.map((r) => this.view(r, access.accountId)));
  }

  async approve(
    actor: Actor,
    access: EffectiveAccess,
    batchId: string,
    now = new Date(),
  ): Promise<HolidayBatchView> {
    return this.decide(actor, access, batchId, 'approved', now);
  }

  /** Rejecting is a decision too: it also needs a second person. Nothing is saved. */
  async reject(
    actor: Actor,
    access: EffectiveAccess,
    batchId: string,
    now = new Date(),
  ): Promise<HolidayBatchView> {
    return this.decide(actor, access, batchId, 'rejected', now);
  }

  private async decide(
    actor: Actor,
    access: EffectiveAccess,
    batchId: string,
    status: 'approved' | 'rejected',
    now: Date,
  ): Promise<HolidayBatchView> {
    assertMayDecide(access);
    await assertFreshMfa(this.config, actor, now);
    const decidedBy = actor.accountId;
    if (status === 'approved') {
      await this.stepUp.assert(actor, {
        type: 'holidays',
        id: batchId,
        amountRial: null,
        step: 'approve',
      });
    }
    if (decidedBy === null) throw new ForbiddenException();
    if (!UUID.test(batchId)) throw new NotFoundException({ error: 'batch_not_found' });
    const done = await this.db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(holidayBatches)
        .where(eq(holidayBatches.id, batchId))
        .for('update');
      if (!batch) throw new NotFoundException({ error: 'batch_not_found' });
      if (batch.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      if (decidedBy === batch.requestedBy) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }
      let savedCount: number | null = null;
      if (status === 'approved') {
        // All or none: a day there already throws, and the whole transaction rolls back.
        for (const day of daysOf(batch)) {
          await this.holidays.addInTransaction(tx, actor, {
            on: toJalali(new Date(`${day.on}T12:00:00Z`)),
            title: day.title,
            ...(day.cityCode ? { cityCode: day.cityCode } : {}),
            reason: batch.reason,
          });
        }
        savedCount = daysOf(batch).length;
      }
      const [decided] = await tx
        .update(holidayBatches)
        .set({ status, decidedBy, decidedAt: now, savedCount })
        .where(eq(holidayBatches.id, batchId))
        .returning();
      if (!decided) throw new Error('holiday batch decision returned nothing');
      await this.audit.record(
        {
          actor,
          action:
            status === 'approved'
              ? 'config.holiday_batch_approved'
              : 'config.holiday_batch_rejected',
          entityType: 'holiday_batch',
          entityId: batchId,
          before: { status: 'pending' },
          after: { status, savedCount },
          reason: batch.reason,
        },
        tx,
      );
      return decided;
    });
    return this.view(done, decidedBy);
  }

  private async view(r: Row, viewer: string | null): Promise<HolidayBatchView> {
    const days = daysOf(r);
    return {
      id: r.id,
      year: r.year,
      days: [...days],
      reason: r.reason,
      status: r.status,
      requestedAt: r.createdAt.toISOString(),
      requestedByMe: viewer !== null && r.requestedBy === viewer,
      affectedContractsAtRequest: r.affectedContracts,
      affectedContractsNow:
        r.status === 'pending' ? await this.suggestions.affectedContracts(national(days)) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      savedCount: r.savedCount,
    };
  }
}

function national(days: readonly BatchDay[]): string[] {
  return days.filter((d) => !d.cityCode).map((d) => d.on);
}

function daysOf(r: Row): readonly BatchDay[] {
  if (!Array.isArray(r.days)) throw new BadRequestException({ error: 'invalid_batch' });
  return r.days as BatchDay[];
}

function assertMayManage(access: EffectiveAccess) {
  // Rule 12: checked here as well as by the guard.
  if (!access.permissions.has(MANAGE)) {
    throw new ForbiddenException({ error: 'permission_required', permission: MANAGE });
  }
}

/** A second open batch for the same year (holiday_batches_open_key). */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

/** Seeing and deciding a pending request: whoever may ask, or the deputy who only decides. */
function assertMayDecide(access: EffectiveAccess) {
  // Rule 12: checked here as well as by the guard.
  if (!access.permissions.has(MANAGE) && !access.permissions.has(APPROVE)) {
    throw new ForbiddenException({ error: 'permission_required', permission: APPROVE });
  }
}
