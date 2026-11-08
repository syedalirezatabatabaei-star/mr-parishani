import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { PatientMobileChangeView } from '@sepehr/contracts';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  PERSON_MOBILE_CHANGE,
  type PersonMobileChange,
} from '../../common/lead/person-mobile-change.port';
import { DATABASE, type Database } from '../../db/database.module';
import { REDIS } from '../../infra/redis.module';
import { FactorNotices } from './factor-notices';
import { patientMobileChangeRequests, sessions, userAccounts } from './identity.schema';
import { OtpChallengeService } from './otp-challenge.service';
import { tooManyRequests } from './otp-login.service';
import { RateLimiter } from './rate-limiter';

/** Apart from the patient's own change: this code proves the new mobile to staff. */
const PURPOSE = 'patient_mobile_change_staff';

type Row = typeof patientMobileChangeRequests.$inferSelect;
type Executor = Pick<Database, 'select'>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ف۱۲ ب۲ (owner 1405/07/26; migration 0091): the patient's previous mobile is lost, so staff
 * replace their login mobile, by two people as 0085.
 *
 * - The first holder of `identity.change_patient_mobile` finds the account by its current
 *   mobile and sends a code to the new one; the patient reads it back. The first proposes
 *   with that code (a typo never hands the account to a stranger), the evidence seen and a
 *   reason, after the TOTP code again (R1).
 * - A second holder, never the first, approves, after R1 too; the database holds the same
 *   rule (patient_mobile_change_requests_two_people_check). Refusing takes one.
 * - Approving does in one transaction what the patient's own change does (ف۱۲ ب۱): the
 *   account row locked, the account's login mobile still the one proposed from, the new one
 *   nobody's, the Person's mobiles through the lead port, the login mobile, every session of
 *   the patient ended, the previous mobile told and the audit, with the last four digits
 *   only (rule 30). Advertising consent is not carried over; cases stay on the Person.
 * - Behind the same flag as ب۱, `identity.patient_mobile_change`, off until launch. The wait
 *   between changes (`cooldownDays`) is the patient's own path's: recovery is not held back.
 * - A request not decided within `staffRequestDays` (owner 1405/07/27: 7) expires, by the
 *   value in force when it was proposed (rule 16). Lazily, as the TOTP reset's: deciding it
 *   records the expiry, commits and answers 410; the queue leaves it out; proposing again
 *   for the same account or new mobile expires it first, so its open key no longer blocks.
 */
@Injectable()
export class PatientMobileStaffService {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(REDIS) redis: Redis,
    private readonly challenge: OtpChallengeService,
    private readonly notices: FactorNotices,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
    @Optional()
    @Inject(PERSON_MOBILE_CHANGE)
    private readonly persons?: PersonMobileChange,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  /** The code to the new mobile, which the patient reads back to the first person. */
  async sendCode(
    actor: Actor,
    input: { currentMobile: string; newMobile: string },
    now = new Date(),
  ) {
    const staff = await this.staff(actor, now);
    await this.checkMobiles(this.db, input.currentMobile, input.newMobile);
    const { value: otp } = await this.config.resolve('identity.otp', {}, now);
    // Per staff account, as the patient's own: one desk cannot spray codes at many numbers.
    const perStaff = await this.limiter.hit(
      `patient-mobile-change:staff:${staff}`,
      otp.sendsPerMobilePerHour,
      60 * 60,
    );
    if (!perStaff.allowed) throw tooManyRequests('rate_limited', perStaff.retryAfterSeconds);
    return this.challenge.send(input.newMobile, PURPOSE, { ip: actor.ip }, now);
  }

  /** The first of the two: proposes, with the new mobile's code and the evidence seen. */
  async propose(
    actor: Actor,
    input: {
      currentMobile: string;
      newMobile: string;
      code: string;
      reason: string;
      evidence: string;
    },
    now = new Date(),
  ): Promise<PatientMobileChangeView> {
    const requestedBy = await this.staff(actor, now);
    await assertFreshMfa(this.config, actor, now);
    // ADR-052: a patient's new login number is identity; signed with the asker's SMS code.
    await this.stepUp.assert(actor, {
      type: 'patient_mobile',
      id: requestedBy,
      amountRial: null,
      step: 'request',
    });
    await this.checkMobiles(this.db, input.currentMobile, input.newMobile);
    // A wrong code counts toward the lockout and proposes nothing.
    await this.challenge.verify(input.newMobile, PURPOSE, input.code, { ip: actor.ip }, now);
    const row = await this.db
      .transaction(async (tx) => {
        const account = await this.checkMobiles(tx, input.currentMobile, input.newMobile, true);
        // An open request past its time no longer holds the account or the new mobile.
        const open = await tx
          .select()
          .from(patientMobileChangeRequests)
          .where(
            and(
              eq(patientMobileChangeRequests.status, 'pending'),
              or(
                eq(patientMobileChangeRequests.targetAccountId, account.id),
                eq(patientMobileChangeRequests.toMobile, input.newMobile),
              ),
            ),
          )
          .for('update');
        for (const stale of open) await this.expireIfDue(tx, actor, stale, now);
        const [made] = await tx
          .insert(patientMobileChangeRequests)
          .values({
            targetAccountId: account.id,
            fromMobile: input.currentMobile,
            toMobile: input.newMobile,
            requestedBy,
            reason: input.reason,
            evidence: input.evidence,
          })
          .returning();
        if (!made) throw new Error('patient mobile change insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'identity.patient_mobile_change_proposed',
            entityType: 'user_account',
            entityId: account.id,
            // The last four digits only (rule 30); the evidence stays in the request row.
            before: { mobileLastFour: lastFour(made.fromMobile) },
            after: { mobileLastFour: lastFour(made.toMobile), requestId: made.id },
            reason: input.reason,
          },
          tx,
        );
        return made;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'request_open' });
        throw error;
      });
    return view(row, requestedBy);
  }

  /** The requests waiting for a second person, newest first. */
  async pending(actor: Actor, now = new Date()): Promise<PatientMobileChangeView[]> {
    const viewer = await this.staff(actor, now);
    const rows = await this.db
      .select()
      .from(patientMobileChangeRequests)
      .where(eq(patientMobileChangeRequests.status, 'pending'))
      .orderBy(desc(patientMobileChangeRequests.createdAt))
      .limit(200);
    // Past its time it is no longer waiting, though not yet marked (no write on a read).
    const live: Row[] = [];
    for (const r of rows) if (!(await this.isDue(r, now))) live.push(r);
    return live.map((r) => view(r, viewer));
  }

  async approve(
    actor: Actor,
    id: string,
    reason: string,
    now = new Date(),
  ): Promise<PatientMobileChangeView> {
    return this.decide(actor, id, 'approved', reason, now);
  }

  /** Refusing takes one, the proposer too (withdrawing their own). */
  async reject(
    actor: Actor,
    id: string,
    reason: string,
    now = new Date(),
  ): Promise<PatientMobileChangeView> {
    return this.decide(actor, id, 'rejected', reason, now);
  }

  private async decide(
    actor: Actor,
    id: string,
    status: 'approved' | 'rejected',
    reason: string,
    now: Date,
  ): Promise<PatientMobileChangeView> {
    const decidedBy = await this.staff(actor, now);
    await assertFreshMfa(this.config, actor, now);
    if (status === 'approved') {
      await this.stepUp.assert(actor, {
        type: 'patient_mobile',
        id,
        amountRial: null,
        step: 'approve',
      });
    }
    if (!this.persons) throw new Error('PERSON_MOBILE_CHANGE is not provided');
    const persons = this.persons;
    const done = await this.db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(patientMobileChangeRequests)
        .where(eq(patientMobileChangeRequests.id, id))
        .for('update');
      if (!request) throw new NotFoundException({ error: 'request_not_found' });
      if (request.status === 'expired') throw new GoneException({ error: 'request_expired' });
      if (request.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      // Recorded, not thrown inside: the expiry must commit (as the TOTP reset's).
      if (await this.expireIfDue(tx, actor, request, now)) return null;
      let sessionsEnded: number | null = null;
      if (status === 'approved') {
        // Two people (owner 1405/07/26, as 0085): the proposer never approves their own.
        if (request.requestedBy === decidedBy) {
          throw new ForbiddenException({ error: 'proposed_by_same_account' });
        }
        const [account] = await tx
          .select({
            mobile: userAccounts.mobile,
            personId: userAccounts.personId,
            status: userAccounts.status,
          })
          .from(userAccounts)
          .where(and(eq(userAccounts.id, request.targetAccountId), isNull(userAccounts.deletedAt)))
          .for('update');
        if (!account) throw new NotFoundException({ error: 'patient_not_found' });
        if (account.status !== 'active') {
          throw new ForbiddenException({ error: 'account_disabled' });
        }
        // Changed since the proposal (the patient's own change, another request): not this.
        if (account.mobile !== request.fromMobile) {
          throw new ConflictException({ error: 'patient_mobile_change_stale' });
        }
        if (await this.otherHolder(tx, request.toMobile, request.targetAccountId)) {
          throw new ConflictException({ error: 'mobile_taken' });
        }
        await persons.replaceLoginMobile(tx, actor, {
          personId: account.personId,
          from: request.fromMobile,
          to: request.toMobile,
          accountId: request.targetAccountId,
          at: now,
        });
        await tx
          .update(userAccounts)
          .set({ mobile: request.toMobile })
          .where(eq(userAccounts.id, request.targetAccountId));
        // Every session: whoever holds the lost phone is signed out too.
        const revoked = await tx
          .update(sessions)
          .set({ revokedAt: now, revokeReason: 'patient_mobile_changed' })
          .where(and(eq(sessions.accountId, request.targetAccountId), isNull(sessions.revokedAt)))
          .returning({ id: sessions.id });
        sessionsEnded = revoked.length;
        // The previous mobile is told, after the commit (R2): a theft is not silent.
        await this.notices.record(
          actor,
          {
            accountId: request.targetAccountId,
            event: 'patient_mobile_changed',
            mobile: request.fromMobile,
          },
          tx,
        );
      }
      const [decided] = await tx
        .update(patientMobileChangeRequests)
        .set({ status, decidedBy, decidedAt: now, decisionReason: reason, sessionsEnded })
        .where(eq(patientMobileChangeRequests.id, id))
        .returning();
      if (!decided) throw new Error('patient mobile change decision returned nothing');
      await this.audit.record(
        {
          actor,
          action:
            status === 'approved'
              ? 'identity.patient_mobile_changed'
              : 'identity.patient_mobile_change_rejected',
          entityType: 'user_account',
          entityId: request.targetAccountId,
          before: { mobileLastFour: lastFour(request.fromMobile) },
          after:
            status === 'approved'
              ? {
                  mobileLastFour: lastFour(request.toMobile),
                  method: 'staff',
                  requestId: id,
                  requestedBy: request.requestedBy,
                  approvedBy: decidedBy,
                  sessionsEnded,
                }
              : { mobileLastFour: lastFour(request.toMobile), requestId: id },
          reason,
        },
        tx,
      );
      return decided;
    });
    if (!done) throw new GoneException({ error: 'request_expired' });
    return view(done, decidedBy);
  }

  /** When `request` stops waiting: proposed + staffRequestDays then in force; null: never. */
  private async expiresAt(request: Row): Promise<Date | null> {
    const { value } = await this.config.resolve(
      'identity.patient_mobile_change',
      {},
      request.createdAt,
    );
    if (value.staffRequestDays === 0) return null;
    return new Date(request.createdAt.getTime() + value.staffRequestDays * DAY_MS);
  }

  private async isDue(request: Row, now: Date): Promise<boolean> {
    const at = await this.expiresAt(request);
    return at !== null && at.getTime() <= now.getTime();
  }

  /** Marks a pending request past its time expired, with the audit; whether it did. */
  private async expireIfDue(tx: Tx, actor: Actor, request: Row, now: Date): Promise<boolean> {
    const at = await this.expiresAt(request);
    if (request.status !== 'pending' || at === null || at.getTime() > now.getTime()) return false;
    await tx
      .update(patientMobileChangeRequests)
      .set({ status: 'expired', decidedAt: at })
      .where(eq(patientMobileChangeRequests.id, request.id));
    await this.audit.record(
      {
        actor,
        action: 'identity.patient_mobile_change_expired',
        entityType: 'user_account',
        entityId: request.targetAccountId,
        after: {
          mobileLastFour: lastFour(request.toMobile),
          requestId: request.id,
          expiredAt: at.toISOString(),
        },
      },
      tx,
    );
    return true;
  }

  /** Staff only, the flag on: checked first (rule 12). Returns the staff account id. */
  private async staff(actor: Actor, now: Date): Promise<string> {
    if (actor.accountId === null) throw new ForbiddenException({ error: 'staff_only' });
    const { value } = await this.config.resolve('identity.patient_mobile_change', {}, now);
    if (!value.enabled) throw new ForbiddenException({ error: 'feature_disabled' });
    return actor.accountId;
  }

  /**
   * The patient account whose login is `current`, active; `next` another mobile and no other
   * patient's. Staff may know this: the permission is theirs, no oracle for the public.
   */
  private async checkMobiles(ex: Executor, current: string, next: string, lock = false) {
    if (current === next) throw new ConflictException({ error: 'same_mobile' });
    const query = ex
      .select({ id: userAccounts.id, status: userAccounts.status })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.kind, 'patient'),
          eq(userAccounts.mobile, current),
          isNull(userAccounts.deletedAt),
        ),
      )
      .limit(1);
    const [account] = lock ? await query.for('update') : await query;
    if (!account) throw new NotFoundException({ error: 'patient_not_found' });
    if (account.status !== 'active') throw new ForbiddenException({ error: 'account_disabled' });
    if (await this.otherHolder(ex, next, account.id)) {
      throw new ConflictException({ error: 'mobile_taken' });
    }
    return account;
  }

  private async otherHolder(ex: Executor, mobile: string, accountId: string) {
    const [other] = await ex
      .select({ id: userAccounts.id })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.kind, 'patient'),
          eq(userAccounts.mobile, mobile),
          isNull(userAccounts.deletedAt),
        ),
      )
      .limit(1);
    return other !== undefined && other.id !== accountId;
  }
}

const lastFour = (mobile: string) => mobile.slice(-4);

function view(r: Row, viewer: string): PatientMobileChangeView {
  return {
    id: r.id,
    accountId: r.targetAccountId,
    fromLastFour: lastFour(r.fromMobile),
    toLastFour: lastFour(r.toMobile),
    status: r.status,
    reason: r.reason,
    evidence: r.evidence,
    requestedAt: r.createdAt.toISOString(),
    requestedByMe: r.requestedBy === viewer,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason,
    sessionsEnded: r.sessionsEnded,
  };
}

/** A second open request for the same account or new mobile (the two open keys). */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}
