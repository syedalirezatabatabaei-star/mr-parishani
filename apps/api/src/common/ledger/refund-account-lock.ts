import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../audit/audit.port';

/** The refund accounts (ADR-036; task 4-8): what Aramesh owes a borrower back. */
export type RefundAccountCode = 'fee.refund_payable' | 'downpayment.refund_payable';

/**
 * Serializes everything that takes money out of one borrower's refund account (task 4-8):
 * a bank payment, and the reversal of a cancellation that put a down payment there. Each
 * takes this transaction-scoped lock, then reads the balance, so the account never goes
 * below zero (owner, 1405/07/14). The ledger's own rows are another module's (CLAUDE.md §5).
 */
export async function lockRefundAccount(
  ex: SqlExecutor,
  account: { entityId: string; code: RefundAccountCode; borrowerPersonId: string },
): Promise<void> {
  const key = `refund:${account.entityId}:${account.code}:${account.borrowerPersonId}`;
  await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
