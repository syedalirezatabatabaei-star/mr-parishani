import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CASH_ABANDONMENT_REASON } from '@sepehr/contracts';
import { asc, eq, isNull } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { DATABASE, type Database } from '../../db/database.module';
import { abandonmentReasons } from './lead.schema';
import { pgCode, requirePermission } from './lead.shared';

type ReasonRow = typeof abandonmentReasons.$inferSelect;

const view = (r: ReasonRow) => ({ code: r.code, title: r.title, sortOrder: r.sortOrder });

/**
 * The abandonment reasons (doc 05 §5): a fixed list with the eight base codes, edited from
 * the panel with lead.manage_reasons. A code is never reused; retiring is a soft delete;
 * `chose_cash` is never retired (the service and a trigger), since the cash-service
 * commission hangs on it.
 */
@Injectable()
export class AbandonmentReasonService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  async list(access: EffectiveAccess) {
    requirePermission(access, 'lead.read_cases');
    const rows = await this.db
      .select()
      .from(abandonmentReasons)
      .where(isNull(abandonmentReasons.deletedAt))
      .orderBy(asc(abandonmentReasons.sortOrder), asc(abandonmentReasons.code));
    return rows.map(view);
  }

  async create(
    actor: Actor,
    access: EffectiveAccess,
    input: { code: string; title: string; sortOrder?: number | undefined; reason: string },
  ) {
    requirePermission(access, 'lead.manage_reasons');
    return this.db.transaction(async (tx) => {
      let row: ReasonRow | undefined;
      try {
        [row] = await tx
          .insert(abandonmentReasons)
          .values({
            code: input.code,
            title: input.title,
            sortOrder: input.sortOrder ?? 0,
            createdBy: actor.accountId,
          })
          .returning();
      } catch (error) {
        if (pgCode(error) === '23505') throw new ConflictException({ error: 'reason_code_taken' });
        throw error;
      }
      if (!row) throw new Error('reason insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'lead.abandonment_reason_added',
          entityType: 'abandonment_reason',
          entityId: row.id,
          after: view(row),
          reason: input.reason,
        },
        tx,
      );
      return view(row);
    });
  }

  async update(
    actor: Actor,
    access: EffectiveAccess,
    code: string,
    input: { title?: string | undefined; sortOrder?: number | undefined; reason: string },
  ) {
    requirePermission(access, 'lead.manage_reasons');
    return this.db.transaction(async (tx) => {
      const before = await this.live(tx, code);
      const [row] = await tx
        .update(abandonmentReasons)
        .set({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        })
        .where(eq(abandonmentReasons.id, before.id))
        .returning();
      if (!row) throw new Error('reason update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'lead.abandonment_reason_updated',
          entityType: 'abandonment_reason',
          entityId: row.id,
          before: view(before),
          after: view(row),
          reason: input.reason,
        },
        tx,
      );
      return view(row);
    });
  }

  async retire(actor: Actor, access: EffectiveAccess, code: string, reason: string) {
    requirePermission(access, 'lead.manage_reasons');
    if (code === CASH_ABANDONMENT_REASON) {
      throw new ConflictException({ error: 'reason_not_retirable' });
    }
    await this.db.transaction(async (tx) => {
      const before = await this.live(tx, code);
      await tx
        .update(abandonmentReasons)
        .set({ deletedAt: new Date() })
        .where(eq(abandonmentReasons.id, before.id));
      await this.audit.record(
        {
          actor,
          action: 'lead.abandonment_reason_retired',
          entityType: 'abandonment_reason',
          entityId: before.id,
          before: view(before),
          reason,
        },
        tx,
      );
    });
  }

  private async live(
    ex: Database | Parameters<Parameters<Database['transaction']>[0]>[0],
    code: string,
  ) {
    const [row] = await ex
      .select()
      .from(abandonmentReasons)
      .where(eq(abandonmentReasons.code, code));
    if (!row || row.deletedAt !== null) throw new NotFoundException({ error: 'reason_not_found' });
    return row;
  }
}
