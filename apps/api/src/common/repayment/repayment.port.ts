import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the repayment module (task 1-3, doc 02 §4–5). Installment schedules, received
 * payments and their allocation. Amounts are JS bigints of rials (rule 1).
 */

/**
 * Derived, never stored (rule 4): from the allocations and today's date in Tehran.
 * `written_off` and `cancelled` (glossary) come with the cancellation and collection
 * tasks.
 */
export type InstallmentStatus =
  | 'scheduled'
  | 'due'
  | 'overdue'
  | 'partially_paid'
  | 'paid'
  /** Taken to zero by a schedule revision (task 4-8). */
  | 'cancelled';

export interface InstallmentView {
  readonly id: string;
  readonly index: number;
  /** The Tehran calendar day, YYYY-MM-DD (Gregorian). */
  readonly dueOn: string;
  readonly amountRial: bigint;
  readonly paidRial: bigint;
  readonly outstandingRial: bigint;
  readonly status: InstallmentStatus;
  /** Calendar days since its due day while anything is owed (task 6-1); else 0. */
  readonly daysPastDue: number;
}

export interface ScheduleView {
  readonly id: string;
  readonly caseId: string;
  readonly purseId: string;
  readonly principalRial: bigint;
  readonly planFeeRial: bigint;
  readonly totalRial: bigint;
  readonly fundedAt: Date;
  readonly roundingUnitRial: bigint;
  readonly roundingConfigVersionId: string;
  /** Due days on non-working days were moved to the next working day (task 2-1). */
  readonly dueDatesShifted: boolean;
  /** Locked when the schedule was made (task 6-1; rule 16). */
  readonly graceDays: number;
  readonly installments: readonly InstallmentView[];
  /** The worst of its installments (task 6-1). */
  readonly maxDaysPastDue: number;
  readonly paidRial: bigint;
  readonly outstandingRial: bigint;
  /** Received for this case and not allocated: pending payments and any surplus. */
  readonly unallocatedRial: bigint;
}

export interface PaymentDecision {
  readonly paymentId: string;
  readonly status: 'approved' | 'rejected';
  readonly allocatedRial: bigint;
  /** What stayed in suspense.unallocated: more than the remaining obligation. */
  readonly surplusRial: bigint;
  readonly allocations: readonly { readonly installmentId: string; readonly amountRial: bigint }[];
  readonly replayed: boolean;
}

/** A case with an overdue installment (task 6-7), as of a Tehran day. */
export interface OverdueCase {
  readonly caseId: string;
  readonly maxDaysPastDue: number;
  readonly overdueInstallments: number;
  readonly overdueRial: bigint;
  readonly purseIds: readonly string[];
}

/** A payment on a case's schedules, as the collection unit sees it (task 6-7). */
export interface CasePayment {
  readonly paymentId: string;
  readonly scheduleId: string;
  readonly amountRial: bigint;
  readonly status: 'pending_approval' | 'approved' | 'rejected';
  readonly receivedAt: Date;
}

export interface RepaymentPort {
  /**
   * A new revision of the schedule taking `amountRial` off its last untouched installments
   * (task 4-8; owner, doc 13 open item 3): never an update; refused whole beyond them.
   */
  reduceFromLast(
    actor: Actor,
    input: {
      readonly scheduleId: string;
      readonly amountRial: bigint;
      readonly idempotencyKey: string;
      readonly reason: string;
    },
    tx?: SqlExecutor,
  ): Promise<{ revisionId: string; replayed: boolean }>;
  /** A new revision undoing `revisionId` (a reversed cancellation), once. */
  revertRevision(
    actor: Actor,
    input: {
      readonly revisionId: string;
      readonly idempotencyKey: string;
      readonly reason: string;
    },
    tx?: SqlExecutor,
  ): Promise<{ revisionId: string; replayed: boolean }>;
  /**
   * A cancellation after funding (task 4-8, part 7; owner پ۱۱ الف, س۱): the plan fee of the
   * installments not yet due on `today` (Tehran) and never paid is waived. A new document,
   * Dr company.fee_income / Cr borrower.debt, and a new revision taking the same amount off
   * the schedule from the last untouched installment back; capped by what those hold. Keyed
   * `{idempotencyKey}:journal` and `{idempotencyKey}:schedule`.
   */
  waivePlanFee(
    actor: Actor,
    input: {
      readonly scheduleId: string;
      /** YYYY-MM-DD: the cancellation's day in Tehran. */
      readonly today: string;
      readonly idempotencyKey: string;
      readonly reason: string;
    },
    tx?: SqlExecutor,
  ): Promise<{ waivedRial: bigint; revisionId: string | null; journalEntryId: string | null }>;
  /**
   * A charge outside the installments (task 4-8, part 7; owner پ۱۲-ب ج): the cancellation
   * penalty, a lump sum on its own due day; Dr borrower.debt / Cr company.fee_income. Once
   * per schedule (409 `charge_exists`); the same key again returns it.
   */
  addCharge(
    actor: Actor,
    input: {
      readonly scheduleId: string;
      readonly kind: 'cancellation_penalty';
      readonly amountRial: bigint;
      readonly baseRial: bigint;
      readonly rateBps: number;
      readonly dueOn: string;
      readonly idempotencyKey: string;
      readonly reason: string;
    },
    tx?: SqlExecutor,
  ): Promise<{ chargeId: string; journalEntryId: string; replayed: boolean }>;
  /**
   * The case's installment schedule, on its funded purse. The plan fee and the count come
   * from the caller (the contract module, later); the principal and funded_at from the
   * purse. A plan fee is posted at once (Dr borrower.debt / Cr company.fee_income).
   */
  createSchedule(
    actor: Actor,
    input: {
      readonly idempotencyKey: string;
      readonly purseId: string;
      readonly installmentCount: number;
      readonly planFeeRial: bigint;
      /**
       * ADR-039: the `repayment.rounding_unit_rial` version the case locked, so the schedule
       * is the contract's to the rial. Required: there is no fallback to today's version.
       */
      readonly roundingConfigVersionId: string;
      /**
       * ADR-041: the `repayment.shift_due_to_next_working_day` and `repayment.grace_days`
       * versions the case locked. Required, as the rounding unit. The holidays stay those
       * known at funding (T2).
       */
      readonly shiftConfigVersionId: string;
      readonly graceConfigVersionId: string;
    },
    tx?: SqlExecutor,
  ): Promise<{ scheduleId: string; replayed: boolean }>;
  /** A payment slip received: Dr bank.collection / Cr suspense.unallocated, pending approval. */
  registerReceipt(
    actor: Actor,
    input: {
      readonly idempotencyKey: string;
      readonly scheduleId: string;
      readonly amountRial: bigint;
      readonly receivedAt: Date;
      readonly reference?: string | null;
      /** Task 6-2: a borrower's slip (or a bank file), and what it says. */
      readonly channel?: 'staff' | 'manual_receipt' | 'bank_statement';
      readonly paidOn?: string | null;
      readonly payerName?: string | null;
      readonly submittedByAccountId?: string | null;
      readonly image?: {
        readonly key: string;
        readonly mime: string;
        readonly sha256: string;
      } | null;
    },
    tx?: SqlExecutor,
  ): Promise<{ paymentId: string; replayed: boolean }>;
  /** Allocates to the oldest outstanding installments first; any surplus stays in suspense. */
  approvePayment(
    actor: Actor,
    paymentId: string,
    tx?: SqlExecutor,
    /** Task 6-2: a slip flagged as a likely duplicate needs both. */
    options?: { readonly notDuplicate?: boolean; readonly reason?: string },
  ): Promise<PaymentDecision>;
  /**
   * Task 6-2 (owner): not_received reverses the pending posting exactly; received_unaccepted
   * (the default, phase 1's behaviour) leaves it in suspense until accounting decides.
   */
  rejectPayment(
    actor: Actor,
    paymentId: string,
    reason: string,
    tx?: SqlExecutor,
    kind?: 'not_received' | 'received_unaccepted',
  ): Promise<PaymentDecision>;
  schedule(scheduleId: string, now?: Date, tx?: SqlExecutor): Promise<ScheduleView>;
  /**
   * Of these cases, those whose installments are not all paid (task 2-5b: the lead module
   * asks whether a person is still a customer). Read only.
   */
  casesWithOutstanding(caseIds: readonly string[], tx?: SqlExecutor): Promise<string[]>;
  // Task 6-7, read only: what the collection module follows, never a table of this module.
  /** The cases with an overdue installment today (Tehran), from the amounts as they are now. */
  overdueCases(now?: Date, tx?: SqlExecutor): Promise<OverdueCase[]>;
  /**
   * Task 6-5 (a bulk SMS's filter): the cases with an installment still owed, overdue or
   * not, and their purses. Read only, computed live like overdueCases.
   */
  activeCases(tx?: SqlExecutor): Promise<{ caseId: string; purseIds: string[] }[]>;
  /** A case's schedules, oldest first. */
  schedulesOf(caseId: string, tx?: SqlExecutor): Promise<string[]>;
  /** The payments on a case's schedules, newest first. */
  paymentsOf(caseId: string, tx?: SqlExecutor): Promise<CasePayment[]>;
  /** What was allocated to a case's installments from this moment on. */
  allocatedSince(caseId: string, since: Date, tx?: SqlExecutor): Promise<bigint>;
}

export const REPAYMENT = Symbol('REPAYMENT');
