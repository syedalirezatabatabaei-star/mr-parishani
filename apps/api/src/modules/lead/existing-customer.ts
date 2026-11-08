import { LOAN_CASE_STATUSES } from '@sepehr/contracts';
import { and, inArray, isNull } from 'drizzle-orm';
import type { RepaymentPort } from '../../common/repayment/repayment.port';
import { cases } from './lead.schema';
import type { Tx } from './lead.shared';

/**
 * Whether these persons (one human and everyone merged into them) are a current customer
 * (doc 05 §4, `existing_customer`). The only place this is decided, so that the contract
 * module can replace it.
 *
 * TODO(decision) (task 2-5b decision 3, provisional): a case with a loan in progress
 * (`contracted`, `funded`, `in_treatment`), or any case whose installments are not all
 * paid, asked of the repayment module through its port, never its tables.
 */
export async function isExistingCustomer(
  tx: Tx,
  repayment: RepaymentPort,
  personIds: readonly string[],
): Promise<boolean> {
  if (personIds.length === 0) return false;
  const rows = await tx
    .select({ id: cases.id, status: cases.status })
    .from(cases)
    .where(and(inArray(cases.personId, [...personIds]), isNull(cases.deletedAt)));
  if (rows.some((c) => LOAN_CASE_STATUSES.includes(c.status))) return true;
  if (rows.length === 0) return false;
  const outstanding = await repayment.casesWithOutstanding(
    rows.map((c) => c.id),
    tx,
  );
  return outstanding.length > 0;
}
