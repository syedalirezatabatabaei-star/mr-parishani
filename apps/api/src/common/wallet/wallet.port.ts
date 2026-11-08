import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the credit purse (کیف اعتبار; task 1-2, doc 02 §3–4). The credit, service and
 * settlement modules act on a purse only through it; no endpoint writes to a purse.
 *
 * Every operation takes an idempotency key: the same key and content return the earlier
 * result, other content is refused (409). Pass `tx` to run inside the caller's
 * transaction. Amounts are JS bigints of rials (rule 1).
 */

/** Where a purse may be spent: fixed at approval (doc 02 §4, hard rule). */
export interface PurseScope {
  readonly centerNodeId: string;
  readonly doctorNodeId: string;
  readonly treatmentFieldCode: string;
}

export interface OperationResult {
  readonly purseId: string;
  readonly operationId: string;
  /** Null for hold and release, which post nothing to the ledger. */
  readonly journalEntryId: string | null;
  /** True when the idempotency key was already used: this is the earlier result. */
  readonly replayed: boolean;
}

interface Keyed {
  readonly idempotencyKey: string;
}

/** One service authorization's reservation, derived from the operations log. */
export interface ReservationState {
  readonly authorizationId: string;
  readonly doctorNodeId: string;
  readonly reservedRial: bigint;
  /** Still reserved: neither cancelled nor turned into a registered service. */
  readonly openRial: bigint;
  /** Registered, not yet finalized. */
  readonly pendingRial: bigint;
  readonly finalizedRial: bigint;
  readonly held: boolean;
}

export interface PurseSummary {
  readonly id: string;
  readonly entityId: string;
  readonly caseId: string;
  readonly status: 'approved' | 'funded' | 'closed';
  readonly approvedAmountRial: bigint;
  /** ADR-034: the down payment the purse also holds (0 without one). */
  readonly downPaymentRial: bigint;
  readonly creditApplicationId: string | null;
  /** The borrower (task 5-2b: whose down payment refund a returned service adds to). */
  readonly borrowerPersonId: string;
  readonly fundedAt: Date | null;
  readonly scope: PurseScope;
  /** Balances from the ledger (rule 4), as positive amounts of the purse chain. */
  readonly balances: {
    readonly approvedRial: bigint;
    readonly availableRial: bigint;
    readonly reservedRial: bigint;
    readonly consumedPendingRial: bigint;
    readonly borrowerDebtRial: bigint;
  };
  readonly reservations: readonly ReservationState[];
}

export interface WalletPort {
  /** Credit approval: creates the case's purse (Dr borrower.debt / Cr purse.approved). */
  approveCredit(
    actor: Actor,
    input: Keyed & {
      readonly entityId?: string;
      readonly caseId: string;
      readonly creditApplicationId?: string | null;
      readonly borrowerPersonId: string;
      readonly amountRial: bigint;
      readonly scope: PurseScope;
      /**
       * ADR-034: the down payment Aramesh holds for this case (its `downpayment.held`
       * account, debited), added to what the purse holds; never to the borrower's debt.
       */
      readonly downPayment?: { readonly amountRial: bigint; readonly heldAccountId: string };
    },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  /** Charges the whole approved amount, once; sets funded_at (installment basis). */
  charge(actor: Actor, purseId: string, input: Keyed, tx?: SqlExecutor): Promise<OperationResult>;
  /** Reserves for one service authorization, within the purse's scope. */
  reserve(
    actor: Actor,
    purseId: string,
    input: Keyed & {
      readonly authorizationId: string;
      readonly amountRial: bigint;
      readonly service: PurseScope;
    },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  cancelReservation(
    actor: Actor,
    purseId: string,
    input: Keyed & { readonly authorizationId: string; readonly amountRial: bigint },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  /** The patient confirmed the service (SMS code): reserved → consumed, pending. */
  registerService(
    actor: Actor,
    purseId: string,
    input: Keyed & { readonly authorizationId: string; readonly amountRial: bigint },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  /** Pending consumption becomes the doctor's payable. Refused while held. */
  finalize(
    actor: Actor,
    purseId: string,
    input: Keyed & { readonly authorizationId: string; readonly amountRial: bigint },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  /**
   * Holds an authorization's pending consumption: it cannot be finalized, so it cannot
   * reach the doctor's payable, until released. For the settlement module's disputes.
   */
  hold(
    actor: Actor,
    purseId: string,
    input: Keyed & { readonly authorizationId: string; readonly reason: string },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  release(
    actor: Actor,
    purseId: string,
    input: Keyed & { readonly authorizationId: string; readonly reason: string },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  /**
   * Cancels what is unused (doc 02 §6), all of it or `amountRial` (task 4-8): the loan's
   * part Dr purse.available / Cr borrower.debt, the down payment's Dr purse.available /
   * Cr downpayment.refund_payable (ADR-034's order; ADR-036).
   */
  cancelUnused(
    actor: Actor,
    purseId: string,
    input: Keyed & { readonly reason: string; readonly amountRial?: bigint },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  /**
   * What came back to a **closed** purse (task 5-2b; ADR-038): a service taken back by an
   * accepted dispute returns its amount to available; this takes all of it off again as
   * cancelUnused does on an open one (the loan's part Dr purse.available / Cr borrower.debt,
   * the down payment's Cr downpayment.refund_payable; ADR-036's split). The purse stays
   * closed: a closed purse never reopens (owner, 4-8). 409 `purse_not_closed` on any other.
   */
  returnAfterClose(
    actor: Actor,
    purseId: string,
    input: Keyed & { readonly reason: string; readonly amountRial: bigint },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  /**
   * A new doctor (scope) for the purse (task 4-8): a version, no ledger movement; refused
   * while anything is reserved or pending, or for another treatment field.
   */
  changeScope(
    actor: Actor,
    purseId: string,
    input: Keyed & { readonly scope: PurseScope; readonly reason: string },
    tx?: SqlExecutor,
  ): Promise<{ versionId: string; replayed: boolean }>;
  /** What is unused, by part (ADR-034; task 4-8): the loan's and the down payment's. */
  unusedOf(
    purseId: string,
    tx?: SqlExecutor,
  ): Promise<{ readonly loanRial: bigint; readonly downPaymentRial: bigint }>;
  /** Reverses one operation with the full opposite document (rule 3). */
  reverseOperation(
    actor: Actor,
    purseId: string,
    operationId: string,
    input: Keyed & { readonly reason: string },
    tx?: SqlExecutor,
  ): Promise<OperationResult>;
  summary(purseId: string, tx?: SqlExecutor): Promise<PurseSummary>;
  /**
   * Read only (f7, owner 1405/07/23): the purse's status and its scope now, its latest
   * version, as `summary` gives them, without opening any account (summary may), so it runs
   * in a READ ONLY transaction. Null for no such purse.
   */
  scopeOf(
    purseId: string,
    tx?: SqlExecutor,
  ): Promise<{ readonly status: string; readonly scope: PurseScope } | null>;
  /** Read only (task 5-2b): the installment schedule its funding made, or null. */
  scheduleOfPurse(purseId: string, tx?: SqlExecutor): Promise<string | null>;
  /** The purse funded for a credit application, or null (task 4-8: none before funding). */
  purseOfApplication(creditApplicationId: string, tx?: SqlExecutor): Promise<string | null>;
  /**
   * The purse's AuthorizedRecipient now (task 4-8; doc 12 §7), or null: the service codes go
   * to their mobile, and what they authorize since `since` is at most `amountRial`.
   */
  activeRecipient(purseId: string, tx?: SqlExecutor): Promise<ActiveRecipient | null>;
  /**
   * Closes a funded purse once nothing is left open on it (task 4-8, part 7; owner س۳):
   * nothing available and nothing reserved; else 409 `purse_not_settled`. A used service
   * awaiting settlement is not open: phase 5 still finalizes it on the closed purse.
   * Locks the purse FOR UPDATE; a closed purse is answered as closed (rule 5) and never
   * reopens. No ledger entry: its balances are already zero but for what was used.
   */
  closeIfSettled(
    actor: Actor,
    purseId: string,
    input: { readonly reason: string },
    tx?: SqlExecutor,
  ): Promise<{ closed: true; already: boolean }>;
  /**
   * What cancellations after funding put to each borrower's downpayment.refund_payable, net
   * of their reversals (ADR-036; task 4-8), for the nightly reconciliation. Read only.
   */
  downPaymentRefunds(
    tx?: SqlExecutor,
  ): Promise<{ entityId: string; borrowerPersonId: string; rial: bigint }[]>;
}

export interface ActiveRecipient {
  readonly transferId: string;
  readonly personId: string;
  /** 9XXXXXXXXX: the mobile their code was checked on. */
  readonly mobile: string;
  readonly amountRial: bigint;
  readonly since: Date;
}

export const WALLET = Symbol('WALLET');
