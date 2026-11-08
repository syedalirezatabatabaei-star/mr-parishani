import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the lead module for booking (task 2-6, ADR-027): an appointment made through
 * Sepehr is an intake like any other (doc 05 §1) and its referral stands on a Person and a
 * Case, without booking reading the lead module's tables. The lead module provides it
 * under {@link LEAD_CASES}.
 */

/** Whether a person may book (task 2-6 decision 2). */
export type PersonStanding = 'ok' | 'abuse' | 'do_not_contact';

export interface BookingIntake {
  /** Normalized 9XXXXXXXXX. */
  readonly mobile: string;
  readonly name?: string | null;
  readonly treatmentFieldCode: string;
  readonly cityCode: string | null;
  /** The app and the website are the app's intake; an advisor's booking is theirs. */
  readonly channel: 'app' | 'advisor';
}

export type BookingCase =
  /** Blocked for abuse: nothing is recorded, the booking is refused without a reason. */
  | { readonly kind: 'refused' }
  /**
   * The person's open case (no new case, no turn of the round robin; task 2-6 decision 3)
   * or a new one, assigned as doc 05 says.
   */
  | {
      readonly kind: 'case';
      readonly personId: string;
      readonly caseId: string;
      readonly caseCreated: boolean;
    }
  /**
   * Asked not to be contacted: the intake is recorded as blocked and no case is opened, so
   * no advisor follows it up; the appointment itself goes ahead (decision 2).
   */
  | { readonly kind: 'no_case'; readonly personId: string };

/** Read before the booking's transaction opens (see the lead module's IntakeSettings). */
export interface BookingIntakeSettings {
  readonly opaque: unknown;
}

export interface LeadCases {
  /** Of the person of this mobile, if any; `ok` for a mobile never seen. */
  standingOf(mobile: string, tx?: SqlExecutor): Promise<PersonStanding>;
  /**
   * The (canonical) person of a normalized mobile, or null if none; never creates one
   * (task 7-1: a ticket staff open for a caller).
   */
  personByMobile(mobile: string, tx?: SqlExecutor): Promise<string | null>;
  intakeSettings(): Promise<BookingIntakeSettings>;
  /**
   * The intake of a booking, in the booking's own transaction: the person (found or
   * created), and the case the referral stands on.
   */
  openForBooking(
    tx: SqlExecutor,
    actor: Actor,
    input: BookingIntake,
    settings: BookingIntakeSettings,
  ): Promise<BookingCase>;
  /** This person and everyone merged into them: whose appointments a patient sees. */
  samePersonIds(personId: string, tx?: SqlExecutor): Promise<string[]>;
  /** The person a merge chain ends at (a referral keeps the person of its day). */
  canonicalPersonId(personId: string, tx?: SqlExecutor): Promise<string>;
  /** The case's current advisor, or null. */
  assigneeOf(caseId: string, tx?: SqlExecutor): Promise<string | null>;
  /**
   * What a credit application needs to know of its case (task 3-5): the treatment field
   * and city the plans are chosen by, and whether it is closed. Null if no such case.
   */
  caseFacts(caseId: string, tx?: SqlExecutor): Promise<CaseFacts | null>;
  /**
   * A person's mobile (9XXXXXXXXX), the first one recorded, for a message to them (task
   * 3-5: a guarantor's invitation). Null if they have none. Never logged (rule 30).
   */
  mobileOf(personId: string, tx?: SqlExecutor): Promise<string | null>;
  /** A person's display name as recorded, or null (task 4-1: the parties of a contract). */
  displayNameOf(personId: string, tx?: SqlExecutor): Promise<string | null>;
  /**
   * ADR-048: the customer-club membership that counts for the person (or anyone merged with
   * them) on a Tehran day (YYYY-MM-DD), or null. A credit application locks it.
   */
  clubMembershipAt(personId: string, day: string, tx?: SqlExecutor): Promise<string | null>;
  /**
   * ADR-051: the person's row locked FOR UPDATE in the caller's transaction, so two credit
   * decisions or fundings of one borrower run one after the other.
   */
  lockPerson(tx: SqlExecutor, personId: string): Promise<void>;
  /**
   * Closes an open case with a reason code of the abandonment list (task 3-6: a credit
   * rejection closes its case with `credit_rejected`, doc 10 §6), in the caller's
   * transaction, recorded and audited. False if the case was already closed.
   */
  /**
   * The person a credit transfer's recipient is (task 4-8), found by mobile or national ID,
   * else created with the name, in the caller's transaction; 409 `national_id_mismatch`
   * when the national ID belongs to another person than the mobile's. Normalized input.
   */
  recipientPerson(
    tx: SqlExecutor,
    actor: Actor,
    input: { mobile: string; nationalId: string; name: string },
  ): Promise<{ personId: string }>;
  /**
   * Task 6-2: a case whose loans are all paid, completed in the caller's transaction,
   * recorded and audited (from advising to proforma_issued, SETTLEABLE_CASE_STATUSES, owner
   * 1405/07/23, migration 0086; or in_treatment by the chain);
   * false if it was already closed, or stands elsewhere (new included): then left to staff
   * with an alert (owner 1405/07/15), never passed on automatically.
   */
  completeCase(tx: SqlExecutor, actor: Actor, caseId: string): Promise<boolean>;
  closeCase(
    tx: SqlExecutor,
    actor: Actor,
    caseId: string,
    reasonCode: string,
    note: string | null,
  ): Promise<boolean>;
  /**
   * A new case of the same person, field and city, kept by the same advisor (task 3-7: a
   * large shortfall gets a new case and loan, doc 10 §7), in the caller's transaction,
   * recorded and audited. Its previous case is `fromCaseId`. Null if there is no such case.
   */
  openFollowUpCase(
    tx: SqlExecutor,
    actor: Actor,
    fromCaseId: string,
    reason: string,
  ): Promise<string | null>;
}

export interface CaseFacts {
  readonly caseId: string;
  readonly personId: string;
  readonly treatmentFieldCode: string;
  readonly cityCode: string | null;
  readonly closed: boolean;
}

export const LEAD_CASES = Symbol('LEAD_CASES');
