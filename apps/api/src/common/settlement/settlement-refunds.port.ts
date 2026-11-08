import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the settlement module (task 5-2b), read only: what returned services on closed
 * purses put in each borrower's down payment refund (ADR-038; the rule of 4-8), for the
 * down payments' reconciliation (4-6b), beside the completion refunds and the wallet's
 * cancellations. Never a write.
 */
export interface SettlementRefunds {
  downPaymentRefunds(
    tx?: SqlExecutor,
  ): Promise<{ entityId: string; borrowerPersonId: string; rial: bigint }[]>;
}

export const SETTLEMENT_REFUNDS = Symbol('SETTLEMENT_REFUNDS');
