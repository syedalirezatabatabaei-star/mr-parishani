import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { PermissionCode, StaffMobileChangeView } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { FactorNotices } from './factor-notices';
import { APPROVALS, StaffMobileChanges } from './staff-mobile-changes';

const REQUEST: PermissionCode = 'identity.request_financial_mobile_change';
const APPROVE: PermissionCode = 'identity.approve_financial_mobile_change';

const need = (access: EffectiveAccess, ...any: PermissionCode[]) => {
  if (!any.some((p) => access.permissions.has(p))) {
    throw new ForbiddenException({ error: 'permission_required', permission: any[0] });
  }
};

/**
 * ADR-052 (owner 1405/08/02): a staff member's verified mobile is where their financial SMS
 * codes go. So it changes only by two people holding `identity.approve_financial_mobile_change`
 * (the CEO and the system administrator), neither of them its owner (the database refuses it
 * too); when the owner is one of those two, two other holders approve. The new number takes
 * effect `mobileChangeDelayHours` after the second approval (24); until then the old one stays,
 * and is told at once. Asking, approving and refusing are each signed with an SMS code. Two
 * staff members never share a verified mobile (a unique index).
 */
@Injectable()
export class StaffMobileChangeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
    private readonly notices: FactorNotices,
    private readonly changes: StaffMobileChanges,
  ) {}

  async request(
    actor: Actor,
    access: EffectiveAccess,
    body: { accountId: string; mobile: string; reason: string },
    now = new Date(),
  ): Promise<StaffMobileChangeView> {
    // Owner 1405/08/03: the CEO and the system administrator ask; the third approver only approves.
    need(access, REQUEST);
    if (actor.accountId === null) throw new ForbiddenException();
    if (actor.accountId === body.accountId) {
      throw new ForbiddenException({ error: 'cannot_change_own_mobile' });
    }
    await this.changes.applyDue(body.accountId, now);
    const target = await this.changes.staff(this.db, body.accountId);
    if (target.mobile === body.mobile && target.mobile_verified_at !== null) {
      throw new ConflictException({ error: 'mobile_unchanged' });
    }
    await this.changes.assertFree(this.db, body.accountId, body.mobile);
    await this.stepUp.assert(actor, {
      type: 'approver_mobile',
      id: body.accountId,
      amountRial: null,
      step: 'request',
    });
    const id = await this.db.transaction(async (tx) => {
      // One open change per account: the account's row is the lock.
      await tx.execute(sql`SELECT id FROM user_accounts WHERE id = ${body.accountId} FOR UPDATE`);
      if (await this.changes.openChange(tx, body.accountId)) {
        throw new ConflictException({ error: 'mobile_change_open' });
      }
      const inserted = await tx.execute(sql`
        INSERT INTO staff_mobile_changes (account_id, new_mobile, reason, requested_by)
        VALUES (${body.accountId}, ${body.mobile}, ${body.reason.trim()}, ${actor.accountId})
        RETURNING id
      `);
      const changeId = inserted.rows[0]?.['id'] as string | undefined;
      if (!changeId) throw new Error('mobile change insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'identity.staff_mobile_change_requested',
          entityType: 'user_account',
          entityId: body.accountId,
          // The last four digits only (rule 30).
          after: { changeId, mobileLastFour: body.mobile.slice(-4) },
          reason: body.reason.trim(),
        },
        tx,
      );
      return changeId;
    });
    return this.changes.view(this.db, id, now);
  }

  async decide(
    actor: Actor,
    access: EffectiveAccess,
    changeId: string,
    body: { outcome: 'approved' | 'refused'; reason?: string | undefined },
    now = new Date(),
  ): Promise<StaffMobileChangeView> {
    need(access, APPROVE);
    if (actor.accountId === null) throw new ForbiddenException();
    const first = await this.changes.row(this.db, changeId);
    if (first.account_id === actor.accountId) {
      throw new ForbiddenException({ error: 'cannot_decide_own_mobile' });
    }
    await this.stepUp.assert(actor, {
      type: 'approver_mobile',
      id: changeId,
      amountRial: null,
      step: 'approve',
    });
    const { value: policy } = await this.config.resolve('identity.financial_step_up', {}, now);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM user_accounts WHERE id = ${first.account_id} FOR UPDATE`);
      const change = await this.changes.row(tx, changeId);
      if (change.ended !== null || (change.approved_by?.length ?? 0) >= APPROVALS) {
        throw new ConflictException({ error: 'mobile_change_closed' });
      }
      if (change.approved_by?.includes(actor.accountId ?? '')) {
        throw new ConflictException({ error: 'already_approved' });
      }
      if (body.outcome === 'approved')
        await this.changes.assertFree(tx, change.account_id, change.new_mobile);
      await tx.execute(sql`
        INSERT INTO staff_mobile_change_events (change_id, kind, by_account_id, reason)
        VALUES (${changeId}, ${body.outcome}, ${actor.accountId}, ${body.reason?.trim() ?? null})
      `);
      const second =
        body.outcome === 'approved' && (change.approved_by?.length ?? 0) + 1 === APPROVALS;
      if (second) {
        // The number codes go to today is told now, a day before anything changes.
        const current = await this.changes.staff(tx, change.account_id);
        await this.notices.record(
          actor,
          {
            accountId: change.account_id,
            event: 'mobile_changed',
            mobile: current.mobile_verified_at !== null ? current.mobile : null,
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actor,
          action:
            body.outcome === 'refused'
              ? 'identity.staff_mobile_change_refused'
              : 'identity.staff_mobile_change_approved',
          entityType: 'user_account',
          entityId: change.account_id,
          after: {
            changeId,
            approvals: (change.approved_by?.length ?? 0) + (body.outcome === 'approved' ? 1 : 0),
            ...(second
              ? {
                  effectiveAt: new Date(
                    now.getTime() + policy.mobileChangeDelayHours * 3_600_000,
                  ).toISOString(),
                }
              : {}),
          },
          reason: body.reason?.trim() ?? null,
        },
        tx,
      );
    });
    await this.changes.applyDue(first.account_id, now);
    return this.changes.view(this.db, changeId, now);
  }

  /** The open and recent changes, for the holders of the permission. */
  async list(access: EffectiveAccess, now = new Date()): Promise<StaffMobileChangeView[]> {
    need(access, REQUEST, APPROVE);
    const { rows } = await this.db.execute(sql`
      SELECT id FROM staff_mobile_changes ORDER BY created_at DESC LIMIT 100
    `);
    const out: StaffMobileChangeView[] = [];
    for (const r of rows) out.push(await this.changes.view(this.db, r['id'] as string, now));
    return out;
  }
}
