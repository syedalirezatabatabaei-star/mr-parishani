import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';
import { DATABASE, type Database } from '../../db/database.module';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { totpResetRequests, userAccounts } from './identity.schema';
import { FactorNotices } from './factor-notices';
import { SessionService } from './session.service';

/**
 * Resetting a staff member's TOTP (they lost their phone). There are no recovery codes;
 * one administrator requests the reset and a different one approves it (maker-checker,
 * doc 04 §5), otherwise one administrator could take over any account. The database
 * enforces the same rule (totp_reset_requests_two_people_check). A request nobody
 * decides in time (`identity.staff_login`, 6 hours; the lifetime in effect when it was
 * made) expires and must be made again.
 *
 * Requesting, approving and rejecting each need a TOTP code given again in the session
 * (task 9-3, R1: `identity.reauth`). An approval tells the target by SMS (R2).
 */
@Injectable()
export class TotpResetService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: ConfigPort,
    private readonly notices: FactorNotices,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  async request(
    actor: Actor,
    targetAccountId: string,
    reason: string,
    now = new Date(),
  ): Promise<string> {
    await assertFreshMfa(this.config, actor, now);
    const requestedBy = actor.accountId;
    if (requestedBy === null) throw new ForbiddenException();
    if (requestedBy === targetAccountId) {
      throw new ForbiddenException({ error: 'cannot_reset_own_totp' });
    }
    // ADR-052: resetting a login factor is identity; signed with the asker's SMS code.
    await this.stepUp.assert(actor, {
      type: 'totp_reset',
      id: targetAccountId,
      amountRial: null,
      step: 'request',
    });
    if (reason.trim().length === 0) throw new BadRequestException({ error: 'reason_required' });
    const [target] = await this.db
      .select({ kind: userAccounts.kind })
      .from(userAccounts)
      .where(and(eq(userAccounts.id, targetAccountId), isNull(userAccounts.deletedAt)));
    if (!target || target.kind === 'patient') throw new NotFoundException();

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(totpResetRequests)
        .values({ targetAccountId, requestedBy, reason: reason.trim() })
        .returning({ id: totpResetRequests.id });
      if (!row) throw new Error('reset request insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'identity.totp_reset_requested',
          entityType: 'user_account',
          entityId: targetAccountId,
          after: { requestId: row.id },
          reason: reason.trim(),
        },
        tx,
      );
      return row.id;
    });
  }

  /**
   * A second person approves: the TOTP secret is cleared and every session of the target
   * ends, so their next login must enroll a new device.
   */
  async approve(actor: Actor, requestId: string, now = new Date()): Promise<void> {
    const targetAccountId = await this.decide(actor, requestId, 'approved', now);
    await this.sessions.revokeAll(targetAccountId, 'totp_reset', now);
  }

  /** Rejecting is a decision too: it also needs a second person. */
  async reject(actor: Actor, requestId: string, now = new Date()): Promise<void> {
    await this.decide(actor, requestId, 'rejected', now);
  }

  private async decide(
    actor: Actor,
    requestId: string,
    status: 'approved' | 'rejected',
    now: Date,
  ): Promise<string> {
    await assertFreshMfa(this.config, actor, now);
    if (status === 'approved') {
      await this.stepUp.assert(actor, {
        type: 'totp_reset',
        id: requestId,
        amountRial: null,
        step: 'approve',
      });
    }
    const decidedBy = actor.accountId;
    if (decidedBy === null) throw new ForbiddenException();
    const outcome = await this.db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(totpResetRequests)
        .where(eq(totpResetRequests.id, requestId))
        .for('update');
      if (!request) throw new NotFoundException();
      if (request.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      if (decidedBy === request.requestedBy || decidedBy === request.targetAccountId) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }

      const { value: policy } = await this.config.resolve(
        'identity.staff_login',
        {},
        request.createdAt,
      );
      const ttlMs = policy.totpResetRequestTtlSeconds * 1000;
      if (now.getTime() - request.createdAt.getTime() > ttlMs) {
        // Recorded, not thrown inside: the expiry must commit.
        await tx
          .update(totpResetRequests)
          .set({ status: 'expired', decidedAt: now })
          .where(eq(totpResetRequests.id, requestId));
        await this.audit.record(
          {
            actor,
            action: 'identity.totp_reset_expired',
            entityType: 'user_account',
            entityId: request.targetAccountId,
            after: { requestId },
          },
          tx,
        );
        return { expired: true as const };
      }

      await tx
        .update(totpResetRequests)
        .set({ status, decidedBy, decidedAt: now })
        .where(eq(totpResetRequests.id, requestId));
      if (status === 'approved') {
        const [target] = await tx
          .update(userAccounts)
          .set({ totpSecretEncrypted: null, totpConfirmedAt: null, totpLastStep: null })
          .where(eq(userAccounts.id, request.targetAccountId))
          .returning({
            mobile: userAccounts.mobile,
            mobileVerifiedAt: userAccounts.mobileVerifiedAt,
          });
        await this.notices.record(
          actor,
          {
            accountId: request.targetAccountId,
            event: 'totp_reset',
            mobile: target?.mobileVerifiedAt ? target.mobile : null,
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actor,
          action:
            status === 'approved' ? 'identity.totp_reset_approved' : 'identity.totp_reset_rejected',
          entityType: 'user_account',
          entityId: request.targetAccountId,
          after: { requestId },
          reason: request.reason,
        },
        tx,
      );
      return { expired: false as const, targetAccountId: request.targetAccountId };
    });
    if (outcome.expired) throw new GoneException({ error: 'request_expired' });
    return outcome.targetAccountId;
  }
}
