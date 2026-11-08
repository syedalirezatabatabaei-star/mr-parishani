import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import {
  purseScopeOf,
  type CreditFundingFacts,
  type CreditFundingFactsPort,
} from '../../common/credit/credit-funding-facts.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import type { Database } from '../../db/database.module';
import { creditApplications } from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The credit module's side of CREDIT_FUNDING_FACTS (task 4-5): the application's row
 * locked FOR SHARE in the funding transaction, its status as it is then, and the amounts
 * of the decision that approved it (CREDIT_CONTRACT_FACTS: what its contract states).
 */
@Injectable()
export class CreditFundingFactsAdapter implements CreditFundingFactsPort {
  constructor(
    @Inject(CREDIT_CONTRACT_FACTS) private readonly contractFacts: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
  ) {}

  async lockForFunding(
    creditApplicationId: string,
    executor: SqlExecutor,
  ): Promise<CreditFundingFacts | null> {
    const tx = executor as Tx;
    const [locked] = await tx
      .select({ status: creditApplications.status })
      .from(creditApplications)
      .where(eq(creditApplications.id, creditApplicationId))
      .for('share');
    if (!locked) return null;
    const cancelled =
      (
        await tx.execute(sql`
          SELECT 1 FROM credit_application_cancellations
          WHERE credit_application_id = ${creditApplicationId} AND status = 'approved'
        `)
      ).rows.length > 0;
    const facts = await this.contractFacts.facts(creditApplicationId);
    if (!facts) return null;
    const proforma = await this.proformas.proforma(facts.proformaId, tx);
    const workplace = proforma ? await this.workplaces.workplace(proforma.workplaceId, tx) : null;
    const caseFacts = await this.leads.caseFacts(facts.caseId, tx);
    if (!workplace || !caseFacts) return null;
    return {
      ...facts,
      // The status as locked now, not as read before the transaction; a cancellation (task
      // 4-8) locks the row FOR UPDATE, so one approved before this lock is seen here.
      status: cancelled ? 'cancelled' : locked.status,
      scope: purseScopeOf(workplace, caseFacts.treatmentFieldCode),
      doctorAccountId: workplace.doctorAccountId,
    };
  }
}
