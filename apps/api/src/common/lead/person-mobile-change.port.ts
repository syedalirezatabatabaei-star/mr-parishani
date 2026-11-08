import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the lead module for identity (ف۱۲, owner 1405/07/26, option «ب»): a patient who is
 * signed in replaces their login mobile with one they proved by a code. The Person's mobiles
 * are the lead module's, so identity changes them only through here, inside its own
 * transaction: the account and the Person move together or not at all.
 */
export interface PersonMobileChange {
  /**
   * The Person's live row of `from` is retired (soft-deleted, history kept) and `to` added
   * active and proved. With no Person (an account not linked yet), only that `to` is free is
   * checked. Throws 409 `mobile_taken` when `to` is live on another Person (never merged
   * automatically), and 409 `mobile_pending` when it waits for approval on this one.
   */
  replaceLoginMobile(
    executor: SqlExecutor,
    actor: Actor,
    input: {
      readonly personId: string | null;
      readonly from: string;
      readonly to: string;
      readonly accountId: string;
      readonly at: Date;
    },
  ): Promise<void>;
}

/** Nest injection token for {@link PersonMobileChange}. */
export const PERSON_MOBILE_CHANGE = 'PersonMobileChange';
