/**
 * Port to the collection unit's escalation (task 6-8): a bounced cheque opens stage 4 (a
 * legal referral, proposed by the agent and decided by the collection manager, task 6-7).
 * The collection module provides it under {@link COLLECTION_ESCALATION}.
 */
export interface CollectionEscalation {
  /** Stage 4's task on the case's open overdue item; false when it has none or has one. */
  chequeBounced(caseId: string): Promise<boolean>;
}

export const COLLECTION_ESCALATION = Symbol('COLLECTION_ESCALATION');
