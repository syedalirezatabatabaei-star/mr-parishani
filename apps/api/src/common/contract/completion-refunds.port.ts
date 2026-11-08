import type { CreditRefundLine } from '@sepehr/contracts';
import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the contract module for a cancellation before funding (task 4-8 [financial];
 * owner 1405/07/14): every approved receipt of the application refunded, without penalty,
 * in the caller's transaction (its credit application row locked FOR UPDATE by the caller):
 *
 * - a fee (origination, or the plan fee paid at completion): Dr `company.fee_income`,
 *   Cr the borrower's `fee.refund_payable` (owner, س۱ and س۲);
 * - the down payment: Dr the borrower's `downpayment.held`, Cr `downpayment.refund_payable`
 *   (ADR-036); one already reversed (bounced) refunds nothing; one funded: 409.
 *
 * Each receipt once (key `contract:receipt:<id>:refund`); calling it again returns the same.
 * The receipts are locked FOR UPDATE, so a receipt being approved meanwhile is refunded too,
 * or waits and then sees the cancellation. The contract module provides it under
 * {@link COMPLETION_REFUNDS}.
 */
export interface CompletionRefundsPort {
  refundAll(
    actor: Actor,
    creditApplicationId: string,
    cancellationId: string,
    tx: SqlExecutor,
  ): Promise<CreditRefundLine[]>;
  /**
   * ADR-045 (owner 1405/07/27): on a cancellation after funding, the unearned part of a plan
   * fee paid in cash at completion (the shares of the installments not yet due on `today`),
   * Dr `company.fee_income`, Cr the borrower's `fee.refund_payable`, in the caller's
   * transaction. Once per receipt (the same key and row as {@link refundAll}); again, the same.
   * Null when nothing is owed back: no fee paid at completion, or every installment due.
   */
  refundUnearnedPlanFee(
    actor: Actor,
    input: {
      readonly creditApplicationId: string;
      /** The cancel_after_funding request: completion_refunds.cancellation_id. */
      readonly operationId: string;
      readonly today: string;
      readonly installments: readonly { readonly index: number; readonly dueOn: string }[];
    },
    tx: SqlExecutor,
  ): Promise<CreditRefundLine | null>;
}

export const COMPLETION_REFUNDS = Symbol('COMPLETION_REFUNDS');
