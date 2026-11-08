import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { PatientMobileChanged } from '@sepehr/contracts';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import type { AuthContext } from '../../common/auth/auth.decorators';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  PERSON_MOBILE_CHANGE,
  type PersonMobileChange,
} from '../../common/lead/person-mobile-change.port';
import { DATABASE, type Database } from '../../db/database.module';
import { REDIS } from '../../infra/redis.module';
import { FactorNotices } from './factor-notices';
import { factorChangeNotices, sessions, userAccounts } from './identity.schema';
import { OtpChallengeService } from './otp-challenge.service';
import { tooManyRequests } from './otp-login.service';
import { RateLimiter } from './rate-limiter';

/** Kept apart from login and other codes: this code proves only the new mobile. */
const PURPOSE = 'patient_mobile_change';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ف۱۲ (owner 1405/07/26, option «ب»): a signed-in patient replaces their login mobile.
 *
 * - Only from an active login: a patient session signed in within
 *   `identity.patient_mobile_change.recentLoginSeconds`, which proves the previous mobile is
 *   held, and no sooner than `cooldownDays` after the last change.
 * - The new mobile is proved by a code sent to it, with the login code's expiry, cooldown,
 *   hourly limits and lockout (`identity.otp`, `identity.lockout`), and an hourly limit per
 *   account as well, so one account cannot spray codes at many numbers.
 * - Whether the new mobile is someone else's is said only after its code is given, so the
 *   form is no oracle of who is registered.
 * - In one transaction: the account's mobile, the Person's mobiles (through the lead port),
 *   the end of the patient's other sessions, the notice to the previous mobile (sent after
 *   the commit) and the audit, with the last four digits only (rule 30).
 * - Advertising consent is per mobile (`sms_consents`) and is not carried over.
 */
@Injectable()
export class PatientMobileService {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(REDIS) redis: Redis,
    private readonly challenge: OtpChallengeService,
    private readonly notices: FactorNotices,
    @Optional()
    @Inject(PERSON_MOBILE_CHANGE)
    private readonly persons?: PersonMobileChange,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  async request(actor: Actor, auth: AuthContext, mobile: string, now = new Date()) {
    const account = await this.allowed(auth, now);
    if (account.mobile === mobile) throw new ConflictException({ error: 'same_mobile' });
    const { value: otp } = await this.config.resolve('identity.otp', {}, now);
    const perAccount = await this.limiter.hit(
      `patient-mobile-change:account:${auth.accountId}`,
      otp.sendsPerMobilePerHour,
      60 * 60,
    );
    if (!perAccount.allowed) throw tooManyRequests('rate_limited', perAccount.retryAfterSeconds);
    return this.challenge.send(mobile, PURPOSE, { ip: actor.ip }, now);
  }

  async verify(
    actor: Actor,
    auth: AuthContext,
    mobile: string,
    code: string,
    now = new Date(),
  ): Promise<PatientMobileChanged> {
    const before = await this.allowed(auth, now);
    if (before.mobile === mobile) throw new ConflictException({ error: 'same_mobile' });
    if (!this.persons) throw new Error('PERSON_MOBILE_CHANGE is not provided');
    const persons = this.persons;
    // A wrong code counts toward the lockout and changes nothing.
    await this.challenge.verify(mobile, PURPOSE, code, { ip: actor.ip }, now);
    const ended = await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select({ mobile: userAccounts.mobile, personId: userAccounts.personId })
        .from(userAccounts)
        .where(eq(userAccounts.id, auth.accountId))
        .for('update');
      if (!account?.mobile) throw new NotFoundException({ error: 'account_not_found' });
      const from = account.mobile;
      const [other] = await tx
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
      if (other) throw new ConflictException({ error: 'mobile_taken' });
      await persons.replaceLoginMobile(tx, actor, {
        personId: account.personId,
        from,
        to: mobile,
        accountId: auth.accountId,
        at: now,
      });
      await tx.update(userAccounts).set({ mobile }).where(eq(userAccounts.id, auth.accountId));
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now, revokeReason: 'patient_mobile_changed' })
        .where(
          and(
            eq(sessions.accountId, auth.accountId),
            isNull(sessions.revokedAt),
            ne(sessions.id, auth.sessionId),
          ),
        )
        .returning({ id: sessions.id });
      // The previous mobile is told, after the commit (R2): a theft is not silent.
      await this.notices.record(
        actor,
        { accountId: auth.accountId, event: 'patient_mobile_changed', mobile: from },
        tx,
      );
      await this.audit.record(
        {
          actor,
          action: 'identity.patient_mobile_changed',
          entityType: 'user_account',
          entityId: auth.accountId,
          before: { mobileLastFour: from.slice(-4) },
          after: {
            mobileLastFour: mobile.slice(-4),
            method: 'self',
            sessionsEnded: revoked.length,
          },
        },
        tx,
      );
      return revoked.length;
    });
    return { mobileLastFour: mobile.slice(-4), sessionsEnded: ended };
  }

  /** A patient, the feature on, a recent sign-in, no recent change: checked first (rule 12). */
  private async allowed(auth: AuthContext, now: Date) {
    if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    const { value } = await this.config.resolve('identity.patient_mobile_change', {}, now);
    if (!value.enabled) throw new ForbiddenException({ error: 'feature_disabled' });
    const signedIn = now.getTime() - auth.authenticatedAt.getTime();
    if (signedIn < 0 || signedIn > value.recentLoginSeconds * 1000) {
      throw new ForbiddenException({ error: 'recent_login_required' });
    }
    if (value.cooldownDays > 0) {
      const [last] = await this.db
        .select({ at: factorChangeNotices.createdAt })
        .from(factorChangeNotices)
        .where(
          and(
            eq(factorChangeNotices.accountId, auth.accountId),
            eq(factorChangeNotices.event, 'patient_mobile_changed'),
          ),
        )
        .orderBy(desc(factorChangeNotices.createdAt))
        .limit(1);
      if (last && now.getTime() - last.at.getTime() < value.cooldownDays * DAY_MS) {
        throw new ConflictException({ error: 'mobile_change_too_soon' });
      }
    }
    const [account] = await this.db
      .select({ mobile: userAccounts.mobile, status: userAccounts.status })
      .from(userAccounts)
      .where(and(eq(userAccounts.id, auth.accountId), isNull(userAccounts.deletedAt)))
      .limit(1);
    if (!account) throw new NotFoundException({ error: 'account_not_found' });
    if (account.status !== 'active') throw new ForbiddenException({ error: 'account_disabled' });
    return account;
  }
}
