import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  BorrowerCapExceeded,
  type BorrowerExposurePort,
  type ExposureRefusal,
  type ExposureStep,
} from '../../common/credit/borrower-exposure.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';
import { creditApplications, creditExposureChecks } from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const APPROVED = ['approved', 'conditional'] as const;

/**
 * ADR-051 (ج۶; owner 1405/07/30, answer 8): the cap on a borrower's whole active balance,
 * `credit.borrower_exposure_cap` (two people; "0" = off). The active balance, without the loan
 * being decided or funded, is the sum over the borrower's other applications (theirs or any
 * Person merged with theirs):
 *
 * - funded, while anything is still owed on its schedule: what is owed (`obligation`, derived,
 *   rule 4) or its approved amount (`loan`);
 * - approved and not yet funded, nor cancelled (`includeApprovedUnfunded`): its approved amount.
 *
 * A guarantee is not counted; a credit transfer (ADR-047) leaves the debt with the borrower.
 * Every caller locks the borrower's row first ({@link lockBorrower}), so two decisions or
 * fundings of one borrower are checked one after the other.
 */
@Injectable()
export class BorrowerExposureService implements BorrowerExposurePort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(REPAYMENT) private readonly repayment: RepaymentPort,
  ) {}

  async lockBorrower(tx: SqlExecutor, borrowerPersonId: string): Promise<void> {
    const canonical = await this.leads.canonicalPersonId(borrowerPersonId, tx);
    await this.leads.lockPerson(tx, canonical);
  }

  async check(
    executor: SqlExecutor,
    creditApplicationId: string,
    amountRial: bigint,
    step: ExposureStep,
  ): Promise<void> {
    const tx = executor as Tx;
    const { value, versionId } = await this.config.resolve('credit.borrower_exposure_cap');
    const capRial = BigInt(value.capRial);
    if (capRial === 0n) return;
    const [app] = await tx
      .select({ borrowerPersonId: creditApplications.borrowerPersonId })
      .from(creditApplications)
      .where(eq(creditApplications.id, creditApplicationId));
    if (!app) throw new Error('the application to check is gone');
    const exposureRial = await this.exposureOf(
      tx,
      app.borrowerPersonId,
      creditApplicationId,
      value.basis,
      value.includeApprovedUnfunded,
    );
    const row = {
      creditApplicationId,
      step,
      exposureRial,
      amountRial,
      capRial,
      basis: value.basis,
      includeApprovedUnfunded: value.includeApprovedUnfunded,
      configVersionId: versionId,
    };
    if (exposureRial + amountRial > capRial) throw new BorrowerCapExceeded(row);
    await tx.insert(creditExposureChecks).values({ ...row, allowed: true });
  }

  async recordRefusal(refusal: ExposureRefusal): Promise<void> {
    await this.db.insert(creditExposureChecks).values({ ...refusal, allowed: false });
  }

  /** The borrower's active balance without `exceptId`, as {@link BorrowerExposureService} says. */
  async exposureOf(
    tx: Tx,
    borrowerPersonId: string,
    exceptId: string,
    basis: 'obligation' | 'loan',
    includeApprovedUnfunded: boolean,
  ): Promise<bigint> {
    const canonical = await this.leads.canonicalPersonId(borrowerPersonId, tx);
    const persons = await this.leads.samePersonIds(canonical, tx);
    const apps = await tx
      .select({
        id: creditApplications.id,
        caseId: creditApplications.caseId,
        status: creditApplications.status,
        approvedAmountRial: creditApplications.approvedAmountRial,
      })
      .from(creditApplications)
      .where(
        and(
          inArray(creditApplications.borrowerPersonId, persons),
          ne(creditApplications.id, exceptId),
          isNull(creditApplications.deletedAt),
        ),
      );
    let total = 0n;
    for (const a of apps) {
      const purseId = await this.wallet.purseOfApplication(a.id, tx);
      if (purseId !== null) {
        const owed = await this.owedOn(tx, a.caseId, purseId);
        if (owed > 0n) total += basis === 'obligation' ? owed : (a.approvedAmountRial ?? 0n);
        continue;
      }
      if (
        includeApprovedUnfunded &&
        (APPROVED as readonly string[]).includes(a.status) &&
        a.approvedAmountRial !== null &&
        !(await this.cancelled(tx, a.id))
      ) {
        total += a.approvedAmountRial;
      }
    }
    return total;
  }

  /** What is still owed on the purse's schedule (derived from the allocations, rule 4). */
  private async owedOn(tx: Tx, caseId: string, purseId: string): Promise<bigint> {
    let owed = 0n;
    for (const scheduleId of await this.repayment.schedulesOf(caseId, tx)) {
      const schedule = await this.repayment.schedule(scheduleId, new Date(), tx);
      if (schedule.purseId === purseId) owed += schedule.outstandingRial;
    }
    return owed;
  }

  private async cancelled(tx: Tx, creditApplicationId: string): Promise<boolean> {
    const found = await tx.execute(sql`
      SELECT 1 FROM credit_application_cancellations
      WHERE credit_application_id = ${creditApplicationId} AND status = 'approved'
    `);
    return found.rows.length > 0;
  }
}
