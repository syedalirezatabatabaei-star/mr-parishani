import type { AppointmentStatus } from '@sepehr/contracts';
import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the referrals of the booking module (doc 08 §8, ADR-027): what a later module
 * (the proforma, task 3-4) may know about a referral without reading booking's tables.
 * The booking module provides it under {@link REFERRAL_DIRECTORY}.
 */
export interface ReferralRecord {
  readonly referralId: string;
  readonly appointmentId: string;
  /** The person of the referral's day (a merge may have moved them since). */
  readonly personId: string;
  /** Null for a person who asked not to be contacted (no case was opened). */
  readonly caseId: string | null;
  readonly doctorId: string;
  readonly workplaceId: string;
  /** The first referral date of a rescheduled chain (task 2-6 decision 4). */
  readonly referredAt: Date;
  /**
   * Where the referral's appointment stands now: a proforma is issued only once it is
   * `examined` (owner 1405/07/23).
   */
  readonly appointmentStatus: AppointmentStatus;
}

export interface ReferralDirectory {
  /** The referral of an appointment made through Sepehr, or null. Runs in `tx` if given. */
  forAppointment(appointmentId: string, tx?: SqlExecutor): Promise<ReferralRecord | null>;
  /** One referral by its id, or null (task 5-3: a cash service needs one to its doctor). */
  referral(referralId: string, tx?: SqlExecutor): Promise<ReferralRecord | null>;
}

export const REFERRAL_DIRECTORY = Symbol('REFERRAL_DIRECTORY');
