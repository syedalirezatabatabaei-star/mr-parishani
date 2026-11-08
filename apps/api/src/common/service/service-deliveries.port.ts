import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the service module for settlement (task 5-1): the services that became final, read
 * only. Each with the doctor, center and treatment field it was authorized for (a later
 * doctor change does not move it), its amount and the moment it became final. The service
 * module provides it under {@link SERVICE_DELIVERIES}; nothing else reads its tables.
 */
export interface FinalizedService {
  readonly authorizationId: string;
  readonly purseId: string;
  readonly creditApplicationId: string;
  readonly workplaceId: string;
  readonly doctorNodeId: string;
  readonly centerNodeId: string;
  readonly treatmentFieldCode: string;
  readonly amountRial: bigint;
  readonly finalizedAt: Date;
}

export interface ServiceDeliveries {
  /** The final service of this authorization; null if there is none (or not final yet). */
  finalized(authorizationId: string, tx?: SqlExecutor): Promise<FinalizedService | null>;
  /** Final services by id after `afterId` (null: from the first), `limit` at most. */
  finalizedAfter(
    afterId: string | null,
    limit: number,
    tx?: SqlExecutor,
  ): Promise<FinalizedService[]>;
}

export const SERVICE_DELIVERIES = Symbol('SERVICE_DELIVERIES');
