import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  HolidayRemovalView,
  PermissionCode,
  requestHolidayRemovalSchema,
} from '@sepehr/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { holidayRemovals } from './config.schema';
import { HolidaySuggestionService } from './holiday-suggestion.service';
import { HolidayService, type HolidayView } from './holiday.service';

const MANAGE: PermissionCode = 'config.manage_holidays';
/** Owner 1405/08/02: the CEO's deputy decides what another asked for, and asks for nothing. */
const APPROVE: PermissionCode = 'config.approve_holidays';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = typeof holidayRemovals.$inferSelect;

/**
 * A holiday taken off the calendar (owner 1405/07/29; ADR-043; migration 0099), as a batch adds
 * one: a holder of config.manage_holidays asks with a reason, a second holder, never the asker,
 * approves (the holiday is soft deleted, announced and audited with the request's reason) or
 * rejects; the database holds the rule too. Both see how many contracts not yet funded print a
 * due day on it (plan 3 (a); a national holiday only). One open request per holiday. Asking and
 * deciding need a TOTP code given again in the session (R1).
 */
@Injectable()
export class HolidayRemovalService {
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
    input: z.output<typeof requestHolidayRemovalSchema>,
    now = new Date(),
  ): Promise<HolidayRemovalView> {
    assertMayManage(access);
    await assertFreshMfa(this.config, actor, now);
    const requestedBy = actor.accountId;
    // ADR-052: removing a holiday moves due days; the asker signs with their own SMS code.
    await this.stepUp.assert(actor, {
      type: 'holidays',
      id: input.holidayId,
      amountRial: null,
      step: 'request',
    });
    if (requestedBy === null) throw new ForbiddenException();
    const holiday = await this.holidays.current(input.holidayId);
    if (!holiday) throw new NotFoundException({ error: 'holiday_not_found' });
    const affectedContracts = await this.affected(holiday);

    const row = await this.db
      .transaction(async (tx) => {
        const [made] = await tx
          .insert(holidayRemovals)
          .values({ holidayId: holiday.id, reason: input.reason, requestedBy, affectedContracts })
          .returning();
        if (!made) throw new Error('holiday removal insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'config.holiday_removal_requested',
            entityType: 'holiday_removal',
            entityId: made.id,
            after: { holidayId: holiday.id, on: holiday.on, affectedContracts },
            reason: input.reason,
          },
          tx,
        );
        return made;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'removal_open' });
        throw error;
      });
    return this.view(row, holiday, requestedBy);
  }

  /** The removals waiting for a second person, newest first, each with its count now. */
  async pending(access: EffectiveAccess): Promise<HolidayRemovalView[]> {
    assertMayDecide(access);
    const rows = await this.db
      .select()
      .from(holidayRemovals)
      .where(eq(holidayRemovals.status, 'pending'))
      .orderBy(desc(holidayRemovals.createdAt))
      .limit(50);
    return Promise.all(
      rows.map(async (r) => this.view(r, await this.holiday(r), access.accountId)),
    );
  }

  async approve(
    actor: Actor,
    access: EffectiveAccess,
    removalId: string,
    now = new Date(),
  ): Promise<HolidayRemovalView> {
    return this.decide(actor, access, removalId, 'approved', now);
  }

  /** Rejecting is a decision too: it also needs a second person. Nothing is removed. */
  async reject(
    actor: Actor,
    access: EffectiveAccess,
    removalId: string,
    now = new Date(),
  ): Promise<HolidayRemovalView> {
    return this.decide(actor, access, removalId, 'rejected', now);
  }

  private async decide(
    actor: Actor,
    access: EffectiveAccess,
    removalId: string,
    status: 'approved' | 'rejected',
    now: Date,
  ): Promise<HolidayRemovalView> {
    assertMayDecide(access);
    await assertFreshMfa(this.config, actor, now);
    const decidedBy = actor.accountId;
    if (status === 'approved') {
      await this.stepUp.assert(actor, {
        type: 'holidays',
        id: removalId,
        amountRial: null,
        step: 'approve',
      });
    }
    if (decidedBy === null) throw new ForbiddenException();
    if (!UUID.test(removalId)) throw new NotFoundException({ error: 'removal_not_found' });
    const { decided, holiday } = await this.db.transaction(async (tx) => {
      const [removal] = await tx
        .select()
        .from(holidayRemovals)
        .where(eq(holidayRemovals.id, removalId))
        .for('update');
      if (!removal) throw new NotFoundException({ error: 'removal_not_found' });
      if (removal.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      if (decidedBy === removal.requestedBy) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }
      const before = await this.holiday(removal, tx);
      const removed =
        status === 'approved'
          ? await this.holidays.removeInTransaction(tx, actor, removal.holidayId, removal.reason)
          : before;
      const [row] = await tx
        .update(holidayRemovals)
        .set({ status, decidedBy, decidedAt: now })
        .where(eq(holidayRemovals.id, removalId))
        .returning();
      if (!row) throw new Error('holiday removal decision returned nothing');
      await this.audit.record(
        {
          actor,
          action:
            status === 'approved'
              ? 'config.holiday_removal_approved'
              : 'config.holiday_removal_rejected',
          entityType: 'holiday_removal',
          entityId: removalId,
          before: { status: 'pending' },
          after: { status, holidayId: removal.holidayId },
          reason: removal.reason,
        },
        tx,
      );
      return { decided: row, holiday: removed };
    });
    return this.view(decided, holiday, decidedBy);
  }

  /** The holiday asked about, removed or not (the request keeps pointing at it). */
  private async holiday(r: Row, tx: SqlExecutor = this.db): Promise<HolidayView> {
    const found = await tx.execute(sql`
      SELECT id, to_char(holiday_on, 'YYYY-MM-DD') AS "on", title, kind, city_code
      FROM holidays WHERE id = ${r.holidayId}
    `);
    const row = found.rows[0] as
      | {
          id: string;
          on: string;
          title: string;
          kind: 'national' | 'city';
          city_code: string | null;
        }
      | undefined;
    if (!row) throw new NotFoundException({ error: 'holiday_not_found' });
    return { id: row.id, on: row.on, title: row.title, kind: row.kind, cityCode: row.city_code };
  }

  /** A due day moves only for a national holiday (ADR-021): a city's counts none. */
  private affected(holiday: HolidayView): Promise<number> {
    return holiday.cityCode === null
      ? this.suggestions.affectedContracts([holiday.on])
      : Promise.resolve(0);
  }

  private async view(
    r: Row,
    holiday: HolidayView,
    viewer: string | null,
  ): Promise<HolidayRemovalView> {
    return {
      id: r.id,
      holidayId: r.holidayId,
      on: holiday.on,
      title: holiday.title,
      cityCode: holiday.cityCode,
      reason: r.reason,
      status: r.status,
      requestedAt: r.createdAt.toISOString(),
      requestedByMe: viewer !== null && r.requestedBy === viewer,
      affectedContractsAtRequest: r.affectedContracts,
      affectedContractsNow: r.status === 'pending' ? await this.affected(holiday) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
    };
  }
}

function assertMayManage(access: EffectiveAccess) {
  // Rule 12: checked here as well as by the guard.
  if (!access.permissions.has(MANAGE)) {
    throw new ForbiddenException({ error: 'permission_required', permission: MANAGE });
  }
}

/** A second open request for the same holiday (holiday_removals_open_key). */
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
