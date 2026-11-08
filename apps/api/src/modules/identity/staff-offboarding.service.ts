import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { StaffOffboardingView } from '@sepehr/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { ACCESS_PORT, type AccessPort } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { staffOffboardingRequests, userAccounts } from './identity.schema';
import { SessionService } from './session.service';

type Row = typeof staffOffboardingRequests.$inferSelect;

/**
 * Offboarding a staff or center account (owner 1405/07/23, plan 4; go-live blocker م۱۱;
 * migration 0087). One holder of identity.request_staff_offboarding asks, with a reason; a
 * different holder of identity.approve_staff_offboarding, never the asker nor the target,
 * approves or rejects (maker-checker, doc 04 §5, as the TOTP reset). The database holds the
 * same rule (staff_offboarding_requests_two_people_check).
 *
 * Approving, in one transaction: the account row locked, its status `disabled` (login and
 * every session read it already, so access ends at the commit), each live role revoked
 * through ACCESS_PORT (one `access.role_revoked` each), the request decided, and
 * `identity.staff_offboarded` audited. Then every session row is revoked. Nothing is deleted
 * (rule 7); coming back is a new account.
 *
 * Asking, approving and rejecting each need a TOTP code given again in the session (R1).
 * No expiry, unlike a TOTP reset: an offboarding only takes access away.
 */
@Injectable()
export class StaffOffboardingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(ACCESS_PORT) private readonly access: AccessPort,
    private readonly sessions: SessionService,
  ) {}

  async request(
    actor: Actor,
    targetAccountId: string,
    reason: string,
    now = new Date(),
  ): Promise<StaffOffboardingView> {
    await assertFreshMfa(this.config, actor, now);
    const requestedBy = actor.accountId;
    if (requestedBy === null) throw new ForbiddenException();
    if (requestedBy === targetAccountId) {
      throw new ForbiddenException({ error: 'cannot_offboard_self' });
    }
    const [target] = await this.db
      .select({ kind: userAccounts.kind, status: userAccounts.status })
      .from(userAccounts)
      .where(and(eq(userAccounts.id, targetAccountId), isNull(userAccounts.deletedAt)));
    // A patient is not staff: no such account here.
    if (!target || target.kind === 'patient') {
      throw new NotFoundException({ error: 'account_not_found' });
    }
    if (target.status !== 'active') throw new ConflictException({ error: 'already_offboarded' });

    const row = await this.db
      .transaction(async (tx) => {
        const [made] = await tx
          .insert(staffOffboardingRequests)
          .values({ targetAccountId, requestedBy, reason })
          .returning();
        if (!made) throw new Error('offboarding request insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'identity.staff_offboarding_requested',
            entityType: 'user_account',
            entityId: targetAccountId,
            after: { requestId: made.id },
            reason,
          },
          tx,
        );
        return made;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'request_open' });
        throw error;
      });
    return view(row, requestedBy, await this.usernameOf(row.targetAccountId));
  }

  /** The requests still waiting for a second person, newest first. */
  async pending(actor: Actor): Promise<StaffOffboardingView[]> {
    const rows = await this.db
      .select({ request: staffOffboardingRequests, username: userAccounts.username })
      .from(staffOffboardingRequests)
      .leftJoin(userAccounts, eq(userAccounts.id, staffOffboardingRequests.targetAccountId))
      .where(eq(staffOffboardingRequests.status, 'pending'))
      .orderBy(desc(staffOffboardingRequests.createdAt))
      .limit(200);
    return rows.map((r) => view(r.request, actor.accountId, r.username));
  }

  async approve(actor: Actor, requestId: string, now = new Date()): Promise<StaffOffboardingView> {
    const decided = await this.decide(actor, requestId, 'approved', now);
    // The status already ends every session at the commit; this marks their rows too.
    await this.sessions.revokeAll(decided.targetAccountId, 'offboarded', now);
    return view(decided, actor.accountId, await this.usernameOf(decided.targetAccountId));
  }

  /** Rejecting is a decision too: it also needs a second person. */
  async reject(actor: Actor, requestId: string, now = new Date()): Promise<StaffOffboardingView> {
    const decided = await this.decide(actor, requestId, 'rejected', now);
    return view(decided, actor.accountId, await this.usernameOf(decided.targetAccountId));
  }

  private async decide(
    actor: Actor,
    requestId: string,
    status: 'approved' | 'rejected',
    now: Date,
  ): Promise<Row> {
    await assertFreshMfa(this.config, actor, now);
    const decidedBy = actor.accountId;
    if (decidedBy === null) throw new ForbiddenException();
    return this.db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(staffOffboardingRequests)
        .where(eq(staffOffboardingRequests.id, requestId))
        .for('update');
      if (!request) throw new NotFoundException({ error: 'request_not_found' });
      if (request.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      if (decidedBy === request.requestedBy || decidedBy === request.targetAccountId) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }

      let rolesRevoked: number | null = null;
      if (status === 'approved') {
        const [account] = await tx
          .select({ status: userAccounts.status })
          .from(userAccounts)
          .where(eq(userAccounts.id, request.targetAccountId))
          .for('update');
        if (account?.status !== 'active') {
          throw new ConflictException({ error: 'already_offboarded' });
        }
        await tx
          .update(userAccounts)
          .set({ status: 'disabled' })
          .where(eq(userAccounts.id, request.targetAccountId));
        rolesRevoked = await this.access.revokeAllOf(
          request.targetAccountId,
          actor,
          request.reason,
          tx,
        );
      }
      const [done] = await tx
        .update(staffOffboardingRequests)
        .set({ status, decidedBy, decidedAt: now, rolesRevoked })
        .where(eq(staffOffboardingRequests.id, requestId))
        .returning();
      if (!done) throw new Error('offboarding decision returned nothing');
      await this.audit.record(
        {
          actor,
          action:
            status === 'approved'
              ? 'identity.staff_offboarded'
              : 'identity.staff_offboarding_rejected',
          entityType: 'user_account',
          entityId: request.targetAccountId,
          ...(status === 'approved'
            ? {
                before: { status: 'active' },
                after: { status: 'disabled', requestId, rolesRevoked },
              }
            : { after: { requestId } }),
          reason: request.reason,
        },
        tx,
      );
      return done;
    });
  }

  private async usernameOf(accountId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ username: userAccounts.username })
      .from(userAccounts)
      .where(eq(userAccounts.id, accountId));
    return row?.username ?? null;
  }
}

function view(r: Row, viewer: string | null, targetUsername: string | null): StaffOffboardingView {
  return {
    id: r.id,
    targetAccountId: r.targetAccountId,
    targetUsername,
    status: r.status,
    reason: r.reason,
    requestedAt: r.createdAt.toISOString(),
    requestedByMe: viewer !== null && r.requestedBy === viewer,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    rolesRevoked: r.rolesRevoked,
  };
}

/** A second open request for the same account (staff_offboarding_requests_open_key). */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}
