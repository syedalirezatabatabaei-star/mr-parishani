import type { SqlExecutor } from '../audit/audit.port';
import type { PurseScope } from '../wallet/wallet.port';
import type { CreditContractFacts } from './credit-contract-facts.port';

/**
 * Port to the credit module for funding (task 4-5; doc 12 §5): the decided application,
 * its status re-read with its row locked FOR SHARE in the funding transaction (owner's
 * requirement 3: a cancellation before funding, task 4-8, must stop it), and the purse's
 * scope: the doctor, center and treatment field the money may be spent with.
 */
export interface CreditFundingFacts extends CreditContractFacts {
  readonly scope: PurseScope;
  /** The doctor's account, for «patient ready» (null while the doctor has none). */
  readonly doctorAccountId: string | null;
}

export interface CreditFundingFactsPort {
  /** Null if there is no such application. Locks its row FOR SHARE in `tx`. */
  lockForFunding(creditApplicationId: string, tx: SqlExecutor): Promise<CreditFundingFacts | null>;
}

export const CREDIT_FUNDING_FACTS = Symbol('CREDIT_FUNDING_FACTS');

/**
 * The purse's scope from the workplace of the proforma (task 4-5 decision): the doctor's
 * node, and the center's id (a private practice: the doctor's node again). Service
 * authorization (task 4-6) builds the same scope from its workplace with this function.
 */
export function purseScopeOf(
  workplace: { readonly nodeId: string; readonly centerId: string | null },
  treatmentFieldCode: string,
): PurseScope {
  return {
    centerNodeId: workplace.centerId ?? workplace.nodeId,
    doctorNodeId: workplace.nodeId,
    treatmentFieldCode,
  };
}
