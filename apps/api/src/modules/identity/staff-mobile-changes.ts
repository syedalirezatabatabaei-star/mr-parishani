import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { StaffMobileChangeView } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export const APPROVALS = 2;

/** What the API does on its own when a change falls due (no person, no session). */
const SYSTEM_ACTOR: Actor = { accountId: null, sessionId: null, ip: null, roles: ['identity'] };

export interface ChangeRow {
  id: string;
  account_id: string;
  new_mobile: string;
  reason: string;
  requested_by: string;
  created_at: Date;
  approved_by: string[] | null;
  second_approved_at: Date | null;
  ended: string | null;
}

/**
 * The changes as stored, and putting a due one in effect (ADR-052). Apart from the service
 * so that the SMS code sender can apply a due change first without depending on it.
 */
@Injectable()
export class StaffMobileChanges {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  /**
   * Puts in effect this account's approved change whose time has come: the new number becomes
   * its verified mobile. Called before a code is sent to the account and before any change is
   * read or made, so nothing waits for a scheduled job.
   */
  async applyDue(accountId: string, now = new Date()): Promise<void> {
    const { value: policy } = await this.config.resolve('identity.financial_step_up', {}, now);
    const delayMs = policy.mobileChangeDelayHours * 3_600_000;
    const open = await this.openChange(this.db, accountId);
    if (!open?.second_approved_at || open.second_approved_at.getTime() + delayMs > now.getTime()) {
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM user_accounts WHERE id = ${accountId} FOR UPDATE`);
      const change = await this.openChange(tx, accountId);
      if (change?.id !== open.id) return;
      const before = await this.staff(tx, accountId);
      await tx.execute(sql`
        UPDATE user_accounts SET mobile = ${change.new_mobile}, mobile_verified_at = ${now}
        WHERE id = ${accountId}
      `);
      await tx.execute(sql`
        INSERT INTO staff_mobile_change_events (change_id, kind) VALUES (${change.id}, 'applied')
      `);
      await this.audit.record(
        {
          actor: SYSTEM_ACTOR,
          action: 'identity.staff_mobile_change_applied',
          entityType: 'user_account',
          entityId: accountId,
          before: { mobileLastFour: before.mobile?.slice(-4) ?? null },
          after: { changeId: change.id, mobileLastFour: change.new_mobile.slice(-4) },
        },
        tx,
      );
    });
  }

  async staff(executor: Database | Tx, accountId: string) {
    const { rows } = await executor.execute(sql`
      SELECT kind, mobile, mobile_verified_at FROM user_accounts
      WHERE id = ${accountId} AND deleted_at IS NULL
    `);
    const row = rows[0] as
      { kind: string; mobile: string | null; mobile_verified_at: Date | null } | undefined;
    if (!row || row.kind !== 'staff') throw new NotFoundException({ error: 'account_not_found' });
    return row;
  }

  /** Another staff member's verified mobile is never given to a second one. */
  async assertFree(executor: Database | Tx, accountId: string, mobile: string) {
    const { rows } = await executor.execute(sql`
      SELECT 1 FROM user_accounts
      WHERE mobile = ${mobile} AND kind = 'staff' AND mobile_verified_at IS NOT NULL
        AND deleted_at IS NULL AND id <> ${accountId}
      LIMIT 1
    `);
    if (rows.length > 0) throw new ConflictException({ error: 'mobile_taken' });
  }

  async row(executor: Database | Tx, changeId: string): Promise<ChangeRow> {
    const { rows } = await executor.execute(sql`
      SELECT c.id, c.account_id, c.new_mobile, c.reason, c.requested_by, c.created_at,
             (SELECT array_agg(e.by_account_id ORDER BY e.created_at) FROM staff_mobile_change_events e
               WHERE e.change_id = c.id AND e.kind = 'approved') AS approved_by,
             (SELECT e.created_at FROM staff_mobile_change_events e
               WHERE e.change_id = c.id AND e.kind = 'approved'
               ORDER BY e.created_at OFFSET ${APPROVALS - 1} LIMIT 1) AS second_approved_at,
             (SELECT e.kind FROM staff_mobile_change_events e
               WHERE e.change_id = c.id AND e.kind IN ('refused', 'withdrawn', 'applied')) AS ended
      FROM staff_mobile_changes c WHERE c.id = ${changeId}
    `);
    const row = rows[0] as ChangeRow | undefined;
    if (!row) throw new NotFoundException({ error: 'mobile_change_not_found' });
    return {
      ...row,
      created_at: new Date(row.created_at),
      second_approved_at: row.second_approved_at ? new Date(row.second_approved_at) : null,
    };
  }

  async openChange(executor: Database | Tx, accountId: string) {
    const { rows } = await executor.execute(sql`
      SELECT c.id FROM staff_mobile_changes c
      WHERE c.account_id = ${accountId} AND NOT EXISTS (
        SELECT 1 FROM staff_mobile_change_events e
        WHERE e.change_id = c.id AND e.kind IN ('refused', 'withdrawn', 'applied')
      )
      ORDER BY c.created_at DESC LIMIT 1
    `);
    const id = rows[0]?.['id'] as string | undefined;
    return id ? this.row(executor, id) : null;
  }

  async view(executor: Database | Tx, changeId: string, now: Date): Promise<StaffMobileChangeView> {
    const c = await this.row(executor, changeId);
    const { value: policy } = await this.config.resolve('identity.financial_step_up', {}, now);
    const effectiveAt = c.second_approved_at
      ? new Date(c.second_approved_at.getTime() + policy.mobileChangeDelayHours * 3_600_000)
      : null;
    const status =
      c.ended === 'applied'
        ? 'applied'
        : c.ended !== null
          ? 'refused'
          : effectiveAt
            ? 'approved'
            : 'open';
    return {
      id: c.id,
      accountId: c.account_id,
      mobileLastFour: c.new_mobile.slice(-4),
      reason: c.reason,
      requestedBy: c.requested_by,
      requestedAt: c.created_at.toISOString(),
      approvedBy: c.approved_by ?? [],
      status,
      effectiveAt: effectiveAt?.toISOString() ?? null,
    };
  }
}
