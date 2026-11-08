import type { SmsAudience, SmsDispatchStatus } from '@sepehr/contracts';
import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the notification module (task 6-4; doc 15 §7): the one way an SMS of phase 6 on is
 * sent. The newest version of the template is filled with the recipient's allowed fields;
 * promotional ones need consent; non-urgent ones wait for the allowed hours. Recorded, not
 * yet sent: the worker queues what is due, so a rolled-back transaction sends nothing.
 */
export interface SendSms {
  readonly templateCode: string;
  /** Must be the template's own (a guarantor's template is never sent to a borrower). */
  readonly audience: SmsAudience;
  readonly mobile: string;
  readonly personId?: string | null;
  readonly values: Readonly<Record<string, string>>;
  /** Task 6-5: this version of the template (a campaign's locked one), not the newest. */
  readonly templateId?: string;
  /** Rule 5: the same key records once. */
  readonly idempotencyKey: string;
  /** Not worth sending after this (a reminder after its day); default a day after due. */
  readonly notAfter?: Date;
  /**
   * Task 6-5: not before this moment (a scheduled SMS); still moved to the allowed hours.
   * Left out, or past: now. Never for an urgent one.
   */
  readonly sendAfter?: Date;
}

export interface NotificationsPort {
  send(
    input: SendSms,
    tx?: SqlExecutor,
  ): Promise<{ dispatchId: string; status: SmsDispatchStatus }>;
  /**
   * Task 6-7: the text a template would send this recipient, filled with their allowed
   * fields only; nothing recorded or sent. The template's audience must be this one.
   */
  preview(
    templateCode: string,
    audience: SmsAudience,
    values: Readonly<Record<string, string>>,
  ): Promise<string>;
  /**
   * Task 6-6: what still waits for its moment (scheduled) under keys starting with this
   * prefix is cancelled; one already released is left. Only the message's status changes.
   */
  cancelScheduled(keyPrefix: string, tx?: SqlExecutor): Promise<number>;
  /**
   * Task 8-2: a consent given outside the panel (the WordPress form), recorded in the consent
   * ledger in the caller's transaction, audited with the mobile masked. Consent only: a
   * withdrawal is never recorded this way.
   */
  recordConsent(
    actor: Actor,
    input: { mobile: string; source: 'wordpress' },
    tx?: SqlExecutor,
  ): Promise<void>;
  /** The worker app, once the provider took it: its message id, for the delivery report. */
  markSent(dispatchId: string, providerMessageId: string | null): Promise<void>;
}

export const NOTIFICATIONS = Symbol('NOTIFICATIONS');

/** Delivery as the provider reports it (task 6-4): by its message id. */
export type DeliveryState = 'delivered' | 'failed' | 'pending';

/** The provider's delivery reports (Kavenegar's status), given to the worker by its app. */
export interface SmsDeliveryStatus {
  status(messageIds: readonly string[]): Promise<ReadonlyMap<string, DeliveryState>>;
}

export const SMS_DELIVERY_STATUS = Symbol('SMS_DELIVERY_STATUS');

/** No provider to ask (the API process, tests): nothing is known yet. */
export const NO_DELIVERY_STATUS: SmsDeliveryStatus = {
  status: () => Promise.resolve(new Map()),
};
