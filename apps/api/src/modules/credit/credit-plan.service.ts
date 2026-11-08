import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { quote, QuoteError, ScheduleError, type CreditPlan, type Quote } from '@sepehr/contracts';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';

/** The configuration versions a preview was made from: lock them on the case (rule 16). */
export interface QuoteVersions {
  readonly plansVersionId: string;
  readonly roundingVersionId: string;
  readonly reductionVersionId: string;
  /**
   * ADR-041: whether due days move to the next working day, and the grace days, as the case
   * saw them when it was created; its schedule uses them, not those in force at funding. They
   * change no amount of the preview.
   */
  readonly shiftVersionId: string;
  readonly graceVersionId: string;
}

export interface LockedQuote {
  readonly versions: QuoteVersions;
  readonly plan: CreditPlan;
  readonly quote: Quote;
}

/**
 * Credit plans and their preview (doc 10 §3; task 3-3). The plans, the rounding unit and
 * whether a patient may reduce the loan are configuration; a preview names the versions
 * it used, and the same versions always give the same preview, whatever was approved
 * since (doc 10 §10 test 5). Only a calculation: no ledger entry (doc 10 §1).
 */
@Injectable()
export class CreditPlanService {
  constructor(@Inject(CONFIG) private readonly config: ConfigPort) {}

  private async read(versions: QuoteVersions | undefined, at: Date) {
    return versions
      ? Promise.all([
          this.config.getVersion('credit.plans', versions.plansVersionId),
          this.config.getVersion('repayment.rounding_unit_rial', versions.roundingVersionId),
          this.config.getVersion(
            'credit.allow_patient_amount_reduction',
            versions.reductionVersionId,
          ),
          this.config.getVersion(
            'repayment.shift_due_to_next_working_day',
            versions.shiftVersionId,
          ),
          this.config.getVersion('repayment.grace_days', versions.graceVersionId),
        ])
      : Promise.all([
          this.config.resolve('credit.plans', {}, at),
          this.config.resolve('repayment.rounding_unit_rial', {}, at),
          this.config.resolve('credit.allow_patient_amount_reduction', {}, at),
          this.config.resolve('repayment.shift_due_to_next_working_day', {}, at),
          this.config.resolve('repayment.grace_days', {}, at),
        ]);
  }

  /**
   * One plan's preview for a proforma total. With `versions`, exactly as a case locked
   * it; without, as the configuration stands at `at`. The funding instant is assumed to
   * be `at` (doc 10 §3: «تاریخ فرضی واریز = امروز»).
   *
   * `staffAmount`: the amount is the credit unit's approved amount (task 3-6, doc 03 §4),
   * not the patient's request, so the patient's reduction switch does not apply.
   */
  async quote(
    planCode: string,
    input: {
      proformaTotalRial: bigint;
      requestedAmountRial?: bigint;
      installmentCount: number;
      /** ADR-050: the proforma's wage lines, for a wage-only plan. */
      wageRial?: bigint | undefined;
    },
    versions?: QuoteVersions,
    at: Date = new Date(),
    options: { staffAmount?: boolean } = {},
  ): Promise<LockedQuote> {
    const [plans, rounding, reduction, shift, grace] = await this.read(versions, at);
    const plan = plans.value.plans.find((p) => p.code === planCode);
    if (!plan) throw new NotFoundException({ error: 'plan_not_found' });
    try {
      return {
        versions: {
          plansVersionId: plans.versionId,
          roundingVersionId: rounding.versionId,
          reductionVersionId: reduction.versionId,
          shiftVersionId: shift.versionId,
          graceVersionId: grace.versionId,
        },
        plan,
        quote: quote(plan, {
          ...input,
          roundingUnitRial: BigInt(rounding.value),
          fundedAt: at,
          allowPatientAmountReduction: options.staffAmount === true || reduction.value,
        }),
      };
    } catch (error) {
      if (error instanceof QuoteError || error instanceof ScheduleError) {
        throw new BadRequestException({ error: error.code });
      }
      throw error;
    }
  }
}
