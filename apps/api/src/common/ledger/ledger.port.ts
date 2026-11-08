import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the ledger module (task 1-1, doc 02, ADR-004). The only way anything is written
 * to the ledger: no other module touches its tables, and no endpoint posts to it.
 *
 * Amounts are JS bigints of rials (rule 1); a `number` is refused at run time too.
 */

export type Direction = 'debit' | 'credit';

export interface JournalLine {
  readonly accountId: string;
  readonly direction: Direction;
  readonly amountRial: bigint;
}

export interface PostJournal {
  /** Legal entity (ADR-007); `aramesh` in version one. */
  readonly entityId: string;
  /** `module.event`, e.g. `wallet.purse_charged`. */
  readonly eventType: string;
  /** When the business event happened (the posting time is recorded separately). */
  readonly occurredAt: Date;
  /**
   * Required (rule 5). The same key with the same content returns the same document;
   * with different content it is refused.
   */
  readonly idempotencyKey: string;
  readonly lines: readonly JournalLine[];
  readonly caseId?: string | null;
  readonly creditApplicationId?: string | null;
  readonly reason?: string | null;
}

export interface PostedLine extends JournalLine {
  readonly id: string;
}

export interface PostedJournal {
  readonly id: string;
  readonly entityId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
  readonly caseId: string | null;
  readonly creditApplicationId: string | null;
  readonly reversesJournalEntryId: string | null;
  readonly reason: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly lines: readonly PostedLine[];
  /** True when the idempotency key was already used: this is the earlier document. */
  readonly replayed: boolean;
}

export type AccountKind = 'asset' | 'liability' | 'income' | 'expense' | 'memo';
export type AccountOwnerType = 'company' | 'borrower' | 'doctor' | 'center' | 'purse';

export interface OpenAccount {
  readonly entityId: string;
  /** Logical code from doc 02 §3, e.g. `purse.available`. */
  readonly code: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly ownerType: AccountOwnerType;
  /** Null for company accounts. */
  readonly ownerId: string | null;
}

/**
 * Sums of an account's entries (rule 4: balances are always computed). Which side is the
 * "normal" balance depends on the account kind and is for presentation.
 */
export interface AccountBalance {
  readonly accountId: string;
  readonly debitRial: bigint;
  readonly creditRial: bigint;
  /** debit − credit. */
  readonly netDebitRial: bigint;
}

export interface LedgerPort {
  /** The account for (entity, code, owner), created if it does not exist yet. */
  openAccount(input: OpenAccount, tx?: SqlExecutor): Promise<{ id: string }>;
  /**
   * The account for (entity, code, owner) if it exists, else null: a read only, which never
   * creates one (task 4-6b: the down payments' reconciliation reads, it does not open).
   */
  findAccount(
    input: Pick<OpenAccount, 'entityId' | 'code' | 'ownerType' | 'ownerId'>,
    tx?: SqlExecutor,
  ): Promise<{ id: string } | null>;
  /**
   * Posts a balanced document. Pass the caller's transaction so the posting commits or
   * fails with the change it records (e.g. the purse row locked FOR UPDATE, rule 5).
   */
  postJournal(actor: Actor, input: PostJournal, tx?: SqlExecutor): Promise<PostedJournal>;
  /** Posts the full opposite of a document (rule 3); a document is reversed only once. */
  reverseJournal(
    actor: Actor,
    journalEntryId: string,
    input: { idempotencyKey: string; reason: string },
    tx?: SqlExecutor,
  ): Promise<PostedJournal>;
  balanceOf(accountId: string, at?: Date, tx?: SqlExecutor): Promise<AccountBalance>;
  /**
   * Read only (b8, owner 1405/07/23): per legal entity, the sums of the entries of every
   * account of one code, whoever owns it. An account no other record points at (an
   * «orphan») is counted too; that is the point. Nothing is written or opened.
   */
  totalsOfCode(code: string, tx?: SqlExecutor): Promise<CodeTotal[]>;
  /**
   * Read only (task 5-7, the Odoo export): the entity's documents whose business moment is in
   * [from, to), oldest first, each with its lines, their account's code and owner. Nothing is
   * written; a reversal is a document of its own.
   */
  journalsBetween(entityId: string, from: Date, to: Date, tx?: SqlExecutor): Promise<JournalRead[]>;
}

/** The sums of one account code's entries within one legal entity. */
export interface CodeTotal {
  readonly entityId: string;
  readonly accounts: number;
  readonly debitRial: bigint;
  readonly creditRial: bigint;
}

/** A posted document as the Odoo export reads it (task 5-7). */
export interface JournalRead {
  readonly id: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly reversesJournalEntryId: string | null;
  readonly lines: readonly {
    readonly accountCode: string;
    readonly ownerType: AccountOwnerType;
    readonly ownerId: string | null;
    readonly direction: Direction;
    readonly amountRial: bigint;
  }[];
}

export const LEDGER = Symbol('LEDGER');
