import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  PERSON_DIRECTORY,
  type EventEnvelope,
  type PersonDirectory,
  type SmsAudience,
} from '@sepehr/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  EVENT_CONSUMERS,
  OUTBOX,
  type EventConsumer,
  type EventConsumerRegistry,
  type OutboxPort,
} from '../../common/events/outbox.port';
import {
  NOTIFICATIONS,
  type NotificationsPort,
} from '../../common/notification/notifications.port';
import type { Database } from '../../db/database.module';
import { factorChangeNotices, userAccounts, type FactorChangeEvent } from './identity.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The SMS template of each change (migration 0080); the text has no personal field. */
const TEMPLATES: Readonly<Record<FactorChangeEvent, string>> = {
  password_changed: 'identity.factor.password_changed',
  totp_reset: 'identity.factor.totp_reset',
  totp_enrolled: 'identity.factor.totp_enrolled',
  mobile_changed: 'identity.factor.mobile_changed',
  patient_mobile_changed: 'identity.factor.patient_mobile_changed',
  // A mobile added to the patient's Person (task 9-3, migration 0081).
  patient_mobile_added: 'identity.factor.patient_mobile_added',
  patient_mobile_approved: 'identity.factor.patient_mobile_approved',
  patient_mobile_rejected: 'identity.factor.patient_mobile_rejected',
};

const PATIENT_EVENTS: ReadonlySet<FactorChangeEvent> = new Set([
  'patient_mobile_changed',
  'patient_mobile_added',
  'patient_mobile_approved',
  'patient_mobile_rejected',
]);

/** What the worker does on its own (a skipped notice), for the audit trail. */
const IDENTITY_SYSTEM_ACTOR: Actor = {
  accountId: null,
  sessionId: null,
  ip: null,
  roles: ['identity'],
};

export interface FactorChange {
  readonly accountId: string;
  readonly event: FactorChangeEvent;
  /** The account's proved mobile (or, for a changed mobile, the previous one); null if none. */
  readonly mobile: string | null;
}

/**
 * Task 9-3 (R2; ASVS 2.2.3, 2.5.5): a login factor changed, so the account is told by SMS.
 * Recorded in the change's own transaction (a notice row and its outbox event), sent only
 * after the commit by {@link FactorNoticeConsumer}: a rolled-back change tells nobody, and a
 * failed SMS never undoes the change. Without a proved mobile nobody can be told: only the
 * audit says so, and the change goes ahead.
 */
@Injectable()
export class FactorNotices {
  constructor(
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  async record(actor: Actor, change: FactorChange, tx: Tx): Promise<void> {
    if (change.mobile === null) {
      await this.audit.record(
        {
          actor,
          action: 'identity.factor_notice_skipped',
          entityType: 'user_account',
          entityId: change.accountId,
          after: { event: change.event, reason: 'no_verified_mobile' },
        },
        tx,
      );
      return;
    }
    const [notice] = await tx
      .insert(factorChangeNotices)
      .values({
        accountId: change.accountId,
        event: change.event,
        audience: PATIENT_EVENTS.has(change.event) ? 'patient' : 'staff',
        mobile: change.mobile,
      })
      .returning({ id: factorChangeNotices.id });
    if (!notice) throw new Error('factor notice insert returned nothing');
    await this.outbox.publish(
      {
        type: 'identity.factor_changed',
        aggregateType: 'user_account',
        aggregateId: change.accountId,
        payload: { noticeId: notice.id },
      },
      tx,
    );
  }
}

/**
 * Sends a factor change notice (task 9-3, R2), run by the worker after the commit. The SMS is
 * recorded through the notification module (urgent: at any hour) under the notice's key, so a
 * redelivered event sends once. A failure throws: the outbox retries the event with backoff
 * and keeps the error; the change itself stands. While `identity.factor_change_sms` is off
 * the notice is set aside (audited), so turning it on never sends old news.
 */
@Injectable()
export class FactorNoticeConsumer implements EventConsumer, OnModuleInit {
  readonly name = 'identity.factor_notice';
  readonly eventTypes = ['identity.factor_changed'];

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(NOTIFICATIONS) private readonly notifications: NotificationsPort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, executor: SqlExecutor): Promise<void> {
    const tx = executor as Tx;
    const { noticeId } = event.payload as { noticeId: string };
    const [notice] = await tx
      .select()
      .from(factorChangeNotices)
      .where(eq(factorChangeNotices.id, noticeId))
      .limit(1);
    if (!notice) throw new Error(`factor notice ${noticeId} not found`);
    const { value } = await this.config.resolve('identity.factor_change_sms');
    if (!value.enabled) {
      await this.audit.record(
        {
          actor: IDENTITY_SYSTEM_ACTOR,
          action: 'identity.factor_notice_skipped',
          entityType: 'user_account',
          entityId: notice.accountId,
          after: { event: notice.event, reason: 'skipped_flag_off', noticeId },
        },
        tx,
      );
      return;
    }
    await this.notifications.send(
      {
        templateCode: TEMPLATES[notice.event],
        audience: notice.audience satisfies SmsAudience,
        mobile: notice.mobile,
        values: {},
        idempotencyKey: `identity.factor:${notice.id}`,
      },
      tx,
    );
  }
}

/**
 * Task 9-3 (go-live blocker م۵, R2): the lead module says a mobile was added to a Person who
 * already existed, approved or refused, or that two Persons were merged; the proved mobiles it
 * chose are told, each through its own patient account, as a factor change notice (the same
 * outbox path, flag and audit). When a pending mobile is approved, its account, unlinked till
 * then, is linked to the Person at once rather than at its next login.
 */
@Injectable()
export class PersonMobileNoticeConsumer implements EventConsumer, OnModuleInit {
  readonly name = 'identity.person_mobile_notice';
  readonly eventTypes = ['lead.person_mobile_changed'];

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(PERSON_DIRECTORY) private readonly persons: PersonDirectory,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly notices: FactorNotices,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, executor: SqlExecutor): Promise<void> {
    const tx = executor as Tx;
    // Checked against the contract when it was published (DOMAIN_EVENTS).
    const payload = event.payload as {
      change: 'added' | 'approved' | 'rejected';
      personMobileId: string | null;
      recipientIds: string[];
    };
    const factor: FactorChangeEvent = `patient_mobile_${payload.change}`;
    for (const mobile of await this.persons.mobilesByIds(payload.recipientIds)) {
      const account = await this.patientOf(tx, mobile);
      if (!account) {
        await this.audit.record(
          {
            actor: IDENTITY_SYSTEM_ACTOR,
            action: 'identity.factor_notice_skipped',
            entityType: 'person',
            entityId: event.aggregateId,
            after: { event: factor, reason: 'no_patient_account' },
          },
          tx,
        );
        continue;
      }
      await this.notices.record(
        IDENTITY_SYSTEM_ACTOR,
        { accountId: account.id, event: factor, mobile },
        tx,
      );
    }
    if (payload.change === 'approved' && payload.personMobileId !== null) {
      const [mobile] = await this.persons.mobilesByIds([payload.personMobileId]);
      const account = mobile ? await this.patientOf(tx, mobile) : null;
      if (mobile && account && account.personId === null) {
        const { personId } = await this.persons.findOrCreateByMobile(mobile);
        if (personId !== null) {
          await tx
            .update(userAccounts)
            .set({ personId })
            .where(and(eq(userAccounts.id, account.id), isNull(userAccounts.personId)));
        }
      }
    }
  }

  private async patientOf(tx: Tx, mobile: string) {
    const [row] = await tx
      .select({ id: userAccounts.id, personId: userAccounts.personId })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.kind, 'patient'),
          eq(userAccounts.mobile, mobile),
          isNull(userAccounts.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
