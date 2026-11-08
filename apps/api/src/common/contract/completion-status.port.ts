import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the contract module for funding (task 4-5; owner, 1405/07/11): whether an
 * application is completed, and its down payment's posting (ADR-034), read and locked
 * inside the funding transaction. The wallet module never reads `case_completions` or
 * the down payment's tables (CLAUDE.md §5). The contract module provides it under
 * {@link COMPLETION_STATUS}.
 */
export interface DownPaymentForFunding {
  readonly postingId: string;
  readonly journalEntryId: string;
  readonly amountRial: bigint;
  /** The borrower's `downpayment.held` account the posting credited. */
  readonly heldAccountId: string;
}

export interface FundingReadiness {
  readonly creditApplicationId: string;
  /** The completion, locked FOR SHARE for the rest of the transaction; null if none. */
  readonly completedAt: Date | null;
  /** The lender of the application's contract (ADR-007), or null without one. */
  readonly entityId: string | null;
  /**
   * The approved down payment's posting, locked FOR UPDATE; posted now if the receipt was
   * approved before ADR-034. Null when the application owes no down payment.
   */
  readonly downPayment: DownPaymentForFunding | null;
  /** Why it cannot fund, if so: `down_payment_reversed`, `down_payment_funded`, … */
  readonly problem: string | null;
}

export interface CompletionStatusPort {
  /** When the application was completed, or null (an indicator, never a due-date basis). */
  completedAt(creditApplicationId: string): Promise<Date | null>;
  /** Everything funding must hold, re-read and locked in `tx` (owner's requirement 3). */
  lockForFunding(
    actor: Actor,
    creditApplicationId: string,
    tx: SqlExecutor,
  ): Promise<FundingReadiness>;
  /** Marks the down payment as moved into the purse, once (the posting's row is locked). */
  markDownPaymentFunded(
    postingId: string,
    purseId: string,
    at: Date,
    tx: SqlExecutor,
  ): Promise<void>;
}

export const COMPLETION_STATUS = Symbol('COMPLETION_STATUS');
