import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the contract module (task 4-8, part 7; owner س۴): the cancellation-penalty rate an
 * application's live contract was made with, locked then (rule 16). A contract made before
 * migration 0044 has no stored rate: it is the configuration in force when it was made. Null
 * without a live contract. The contract module provides it under {@link CONTRACT_TERMS}.
 */
export interface ContractPenaltyTerms {
  readonly contractId: string;
  /** Basis points: 1800 = 18%. */
  readonly penaltyBps: number;
}

export interface ContractTermsPort {
  penaltyOf(creditApplicationId: string, tx?: SqlExecutor): Promise<ContractPenaltyTerms | null>;
  /**
   * Read only (owner 1405/07/23, plan 3 (a)): the credit applications whose live contract (not
   * failed, not a sample) prints a due day among these Gregorian days. Whether one is funded
   * is for the caller to ask the wallet.
   */
  applicationsWithPrintedDueOn(days: readonly string[], tx?: SqlExecutor): Promise<string[]>;
}

export const CONTRACT_TERMS = Symbol('CONTRACT_TERMS');
