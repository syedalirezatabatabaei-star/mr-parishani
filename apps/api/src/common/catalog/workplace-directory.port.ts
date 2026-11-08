import type { CenterStatus } from '@sepehr/contracts';
import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the doctors' workplaces of the catalog module (task 2-5): what booking may know
 * about a workplace without reading the catalog's tables. The catalog module provides it
 * under {@link WORKPLACE_DIRECTORY}.
 */
export interface WorkplaceRecord {
  readonly id: string;
  /** The provider profile: audit rows «on behalf of» name it. */
  readonly doctorId: string;
  /** Null while the doctor has no account. */
  readonly doctorAccountId: string | null;
  readonly nodeId: string;
  /** ltree path of the doctor's node: a center, branch or doctor scope covers it by prefix. */
  readonly nodePath: string;
  readonly cityCode: string;
  /** Null for a private practice. */
  readonly centerId: string | null;
  /**
   * Null for a private practice; else the center's status. A terminated center is frozen
   * (ADR-022); a suspended one takes no new appointments.
   */
  readonly centerStatus: CenterStatus | null;
  /** The doctor's name, as on their profile (appointment SMS, task 2-6). */
  readonly doctorName: string;
  /** The center's name; null for a private practice. */
  readonly placeName: string | null;
}

/** A workplace a purse may move to (f7: the «new doctor» picker). */
export interface WorkplaceCandidate {
  readonly workplaceId: string;
  readonly doctorName: string;
  /** Owner 1405/07/24: the center's name only; no branch, no code. */
  readonly centerName: string | null;
}

export interface WorkplaceDirectory {
  /** A workplace that is not removed, of a doctor who is not removed; else null. */
  workplace(workplaceId: string, tx?: SqlExecutor): Promise<WorkplaceRecord | null>;
  /** The workplace of this doctor node (a purse's scope names it; task 4-8), or null. */
  workplaceByNode(nodeId: string, tx?: SqlExecutor): Promise<WorkplaceRecord | null>;
  /**
   * The workplaces whose doctor node is one of these paths or below one (task 5-6: what a
   * doctor, branch or center scope covers), removed ones included: a doctor still sees what
   * they were paid for there. Empty paths: none.
   */
  workplacesUnder(paths: readonly string[], tx?: SqlExecutor): Promise<WorkplaceRecord[]>;
  /** The treatment fields of the workplace's doctor, by code (task 4-8: a doctor change). */
  doctorFieldCodes(workplaceId: string, tx?: SqlExecutor): Promise<string[]>;
  /**
   * Read only (f7, owner 1405/07/23): the workplaces, not removed, of doctors not removed
   * who have this treatment field, in this city, whose center is active (or a private
   * practice), but the one at `excludeNodeId`; whose center or branch name holds `term`
   * (already normalized) when given, or the doctor's name when `matchDoctorName` (a caller
   * who may see the doctor, doc 04 §4). By doctor name, at most `limit`.
   */
  changeCandidates(
    input: {
      readonly fieldCode: string;
      readonly cityCode: string;
      readonly excludeNodeId: string;
      readonly term: string | null;
      readonly matchDoctorName: boolean;
      readonly limit: number;
    },
    tx?: SqlExecutor,
  ): Promise<WorkplaceCandidate[]>;
  /** Whether `accountId` is a (not removed) secretary of the doctor at this workplace. */
  isSecretary(workplaceId: string, accountId: string, tx?: SqlExecutor): Promise<boolean>;
  /**
   * The services that can be booked with this doctor: the active services of the doctor's
   * treatment fields, and the visit.
   */
  offerableServiceCodes(workplaceId: string, tx?: SqlExecutor): Promise<string[]>;
  /** The names of services by code, for pages (task 2-11); a removed service keeps its name. */
  serviceNames(codes: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * The treatment field an appointment for this service is about (task 2-6: its case's
   * field): the service's own field; for the visit, which has none, the doctor's first
   * field by code. Null if the service is not offerable here or the doctor has no field.
   */
  treatmentFieldFor(
    workplaceId: string,
    serviceCode: string,
    tx?: SqlExecutor,
  ): Promise<string | null>;
}

export const WORKPLACE_DIRECTORY = Symbol('WORKPLACE_DIRECTORY');
