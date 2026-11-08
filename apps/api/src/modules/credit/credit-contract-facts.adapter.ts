import { Inject, Injectable } from '@nestjs/common';
import { originationBase } from '@sepehr/contracts';
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type {
  CreditContractFacts,
  CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import {
  creditApplications,
  creditConditionChecks,
  creditDecisions,
  creditGuarantors,
} from './credit.schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredQuote {
  readonly downPaymentRial: string;
  readonly loanRial?: string;
  readonly originationFeeRial: string;
  readonly planFeeRial: string;
  readonly totalObligationRial: string;
  readonly installments: readonly { index: number; dueOn: string; amountRial: string }[];
  /** ADR-035; absent in a decision stored before it. */
  readonly percentRoundingRial?: string | null;
}

/**
 * The credit module's side of CREDIT_CONTRACT_FACTS (task 4-1): an application and the
 * preview of the decision that approved it (task 3-6), which is what its contract states.
 */
@Injectable()
export class CreditContractFactsAdapter implements CreditContractFactsPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  /** ADR-048: the locked plan and the base its origination fee was a share of. */
  private async origination(
    app: typeof creditApplications.$inferSelect,
    quote: StoredQuote | null,
  ): Promise<CreditContractFacts['origination']> {
    const plans = await this.config.getVersion('credit.plans', app.plansVersionId);
    const plan = plans.value.plans.find((p) => p.code === app.planCode);
    if (!plan) return null;
    const loanRial = BigInt(quote?.loanRial ?? app.loanRial);
    return {
      plansVersionId: app.plansVersionId,
      plan,
      baseRial: originationBase(plan, { proformaTotalRial: app.proformaTotalRial, loanRial }),
    };
  }

  async applicationsOf(personIds: readonly string[]): Promise<string[]> {
    if (personIds.length === 0) return [];
    const rows = await this.db
      .select({ id: creditApplications.id })
      .from(creditApplications)
      .where(
        or(
          inArray(creditApplications.patientPersonId, [...personIds]),
          inArray(creditApplications.borrowerPersonId, [...personIds]),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** The newest approved override of the case's penalty rate (task 4-8, owner پ۱۳). */
  private async penaltyOverride(
    creditApplicationId: string,
  ): Promise<{ id: string; bps: number } | null> {
    const found = await this.db.execute(sql`
      SELECT id, penalty_bps FROM credit_penalty_overrides
      WHERE credit_application_id = ${creditApplicationId} AND status = 'approved'
      ORDER BY decided_at DESC LIMIT 1
    `);
    const row = found.rows[0];
    return row ? { id: row['id'] as string, bps: Number(row['penalty_bps']) } : null;
  }

  private async cancelled(creditApplicationId: string): Promise<boolean> {
    const found = await this.db.execute(sql`
      SELECT 1 FROM credit_application_cancellations
      WHERE credit_application_id = ${creditApplicationId} AND status = 'approved'
    `);
    return found.rows.length > 0;
  }

  async facts(creditApplicationId: string): Promise<CreditContractFacts | null> {
    if (!UUID.test(creditApplicationId)) return null;
    const [app] = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.id, creditApplicationId));
    if (!app) return null;
    const [decision] = await this.db
      .select({ quote: creditDecisions.quote })
      .from(creditDecisions)
      .where(
        and(eq(creditDecisions.creditApplicationId, app.id), eq(creditDecisions.status, 'decided')),
      )
      .orderBy(desc(creditDecisions.closedAt))
      .limit(1);
    const quote = (decision?.quote ?? null) as StoredQuote | null;
    const guarantors = await this.db
      .select({ id: creditGuarantors.id, personId: creditGuarantors.personId })
      .from(creditGuarantors)
      .where(
        and(
          eq(creditGuarantors.creditApplicationId, app.id),
          ne(creditGuarantors.status, 'withdrawn'),
        ),
      )
      .orderBy(asc(creditGuarantors.createdAt));
    const checks = await this.db
      .select()
      .from(creditConditionChecks)
      .where(eq(creditConditionChecks.creditApplicationId, app.id));
    return {
      creditApplicationId: app.id,
      penaltyOverride: await this.penaltyOverride(app.id),
      // Task 4-8: an approved cancellation before funding: no contract, completion or funding.
      status: (await this.cancelled(app.id)) ? 'cancelled' : app.status,
      caseId: app.caseId,
      proformaId: app.proformaId,
      patientPersonId: app.patientPersonId,
      borrowerPersonId: app.borrowerPersonId,
      planTitle: app.planTitle,
      installmentCount: app.installmentCount,
      approvedAmountRial: app.approvedAmountRial,
      downPaymentRial: BigInt(quote?.downPaymentRial ?? app.downPaymentRial),
      originationFeeRial: BigInt(quote?.originationFeeRial ?? app.originationFeeRial),
      planFeeRial: BigInt(quote?.planFeeRial ?? app.planFeeRial),
      planFeeTiming: app.planFeeTiming,
      conditions: (app.conditions ?? []).map((text, index) => ({
        index,
        text,
        checkedAt: checks.find((c) => c.conditionIndex === index)?.createdAt ?? null,
      })),
      totalObligationRial: BigInt(quote?.totalObligationRial ?? app.totalObligationRial),
      installments: (quote?.installments ?? []).map((i) => ({
        index: i.index,
        dueOn: i.dueOn,
        amountRial: BigInt(i.amountRial),
      })),
      guarantors,
      percentRoundingRial: quote?.percentRoundingRial ? BigInt(quote.percentRoundingRial) : null,
      roundingVersionId: app.roundingVersionId,
      shiftVersionId: app.shiftVersionId,
      graceVersionId: app.graceVersionId,
      origination: await this.origination(app, quote),
    };
  }
}
