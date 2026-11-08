import type { SqlExecutor } from '../audit/audit.port';

/**
 * Whether automatic SMS to a borrower are held (task 6-6; doc 15 §5): a borrower recorded as
 * deceased or disabled gets none; following up moves to the guarantor or relatives. The
 * status itself, with its document and the collection manager's approval, is task 6-7's,
 * whose module provides this port.
 */
export interface BorrowerSmsHold {
  isHeld(personId: string, tx?: SqlExecutor): Promise<boolean>;
}

export const BORROWER_SMS_HOLD = Symbol('BORROWER_SMS_HOLD');
