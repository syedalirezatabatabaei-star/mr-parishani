import type { CreditPlan } from '@sepehr/contracts';

/**
 * Port to the credit module for the contract module (task 4-1): what a loan contract is
 * filled with, from a decided credit application, without reading credit's tables. The
 * credit module provides it under {@link CREDIT_CONTRACT_FACTS}.
 */
export interface ContractInstallment {
  readonly index: number;
  /** Gregorian day (YYYY-MM-DD) of the decision's preview. */
  readonly dueOn: string;
  readonly amountRial: bigint;
}

export interface CreditContractFacts {
  readonly creditApplicationId: string;
  readonly status: string;
  readonly caseId: string;
  readonly proformaId: string;
  readonly patientPersonId: string;
  readonly borrowerPersonId: string;
  readonly planTitle: string;
  readonly installmentCount: number;
  /** Null unless approved or conditional. */
  readonly approvedAmountRial: bigint | null;
  readonly downPaymentRial: bigint;
  readonly originationFeeRial: bigint;
  readonly planFeeRial: bigint;
  /** Paid at completion (a receipt), or spread over the installments (doc 10 §3). */
  readonly planFeeTiming: 'at_completion' | 'spread';
  /** A conditional approval's conditions, each ticked or not (task 4-3, doc 12 §4). */
  readonly conditions: readonly {
    readonly index: number;
    readonly text: string;
    readonly checkedAt: Date | null;
  }[];
  readonly totalObligationRial: bigint;
  readonly installments: readonly ContractInstallment[];
  /** Guarantors not withdrawn, in the order they were invited. */
  readonly guarantors: readonly { readonly id: string; readonly personId: string }[];
  /**
   * Task 4-8 (owner پ۱۳): the case's own cancellation-penalty rate, approved by two people
   * before its contract; null: the configured rate. A contract locks whichever it is made with.
   */
  readonly penaltyOverride: { readonly id: string; readonly bps: number } | null;
  /** ADR-035: the plan rounds its shares to this many rials; null: whole rials. */
  readonly percentRoundingRial: bigint | null;
  /**
   * ADR-039: the `repayment.rounding_unit_rial` version the application locked when it was
   * created; its preview, decision and contract used it, and so does its schedule.
   */
  readonly roundingVersionId: string;
  /**
   * ADR-041: the `repayment.shift_due_to_next_working_day` and `repayment.grace_days`
   * versions the application locked when it was created; its schedule uses them.
   */
  readonly shiftVersionId: string;
  readonly graceVersionId: string;
  /**
   * ADR-048: the plan the application locked (its `credit.plans` version) and what its
   * origination fee is a share of, so the waiver and the discount are taken off the same base.
   * Null for a plan code no longer in that version (never, by rule 16; defensive).
   */
  readonly origination: {
    readonly plansVersionId: string;
    readonly plan: CreditPlan;
    readonly baseRial: bigint;
  } | null;
}

export interface CreditContractFactsPort {
  /** Null if there is no such application. */
  facts(creditApplicationId: string): Promise<CreditContractFacts | null>;
  /** The applications whose patient or borrower is one of these persons (task 4-2). */
  applicationsOf(personIds: readonly string[]): Promise<string[]>;
}

export const CREDIT_CONTRACT_FACTS = Symbol('CREDIT_CONTRACT_FACTS');
