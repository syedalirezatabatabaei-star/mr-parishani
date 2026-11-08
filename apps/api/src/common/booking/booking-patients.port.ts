import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the booking module's patients (task 6-5; doc 15 §7): who had a confirmed,
 * attended or examined appointment at these workplaces, for a bulk SMS's named filter.
 * Read only; the notification module never reads booking's tables.
 */
export interface BookingPatient {
  /** Null when the appointment has no person yet (the mobile still names them). */
  readonly personId: string | null;
  /** Normalized 9XXXXXXXXX. */
  readonly mobile: string;
}

export interface BookingPatients {
  /** One row per mobile, the latest person of it; `from` and `to` bound the start, Tehran days. */
  patientsAt(
    workplaceIds: readonly string[],
    range: { from: Date | null; to: Date | null },
    tx?: SqlExecutor,
  ): Promise<BookingPatient[]>;
  /** Owner 1405/08/10 (the bell): the patient account an appointment was booked for, if any. */
  patientAccountOf?(appointmentId: string, tx?: SqlExecutor): Promise<string | null>;
}

export const BOOKING_PATIENTS = Symbol('BOOKING_PATIENTS');
