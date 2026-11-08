import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the proformas of the proforma module (task 3-4): what the credit application
 * (task 3-5) may know about the proforma it finances, without reading its tables. The
 * proforma module provides it under {@link PROFORMA_DIRECTORY}.
 */
export interface ProformaRecord {
  readonly proformaId: string;
  readonly caseId: string;
  /** The patient: the person of the referral's day. */
  readonly personId: string;
  readonly doctorId: string;
  readonly workplaceId: string;
  readonly cityCode: string;
  readonly version: number;
  readonly status: string;
  readonly totalRial: bigint;
  /** The patient's note when they disputed it (task 7-1: the ticket's first message). */
  readonly patientResponseNote: string | null;
  /** ADR-050 amendment: who drafted and who issued it (its split of wage and materials). */
  readonly createdBy: string | null;
  readonly issuedBy: string | null;
}

/** A line of a proforma (task 4-6: what a service authorization is made of). */
export interface ProformaLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly serviceCode: string;
  readonly quantity: number;
  readonly lineTotalRial: bigint;
  /** ADR-050: the doctor's wage or materials, as issued. */
  readonly costKind: 'wage' | 'material';
}

export interface ProformaDirectory {
  /** A proforma (not discarded), or null. Runs in `tx` if given. */
  proforma(proformaId: string, tx?: SqlExecutor): Promise<ProformaRecord | null>;
  /** Its lines, by line number; none if it does not exist. Runs in `tx` if given. */
  lines(proformaId: string, tx?: SqlExecutor): Promise<ProformaLineRecord[]>;
}

export const PROFORMA_DIRECTORY = Symbol('PROFORMA_DIRECTORY');
