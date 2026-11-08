import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the service module (task 5-2b; ADR-038): a final service taken back by an
 * accepted dispute on its doctor's payable. Only settlement calls it, in its own transaction;
 * no endpoint reaches it. The wallet's reversals are settlement's to make; this locks the
 * authorization and records that it was taken back.
 */
export interface FinalizedService {
  readonly authorizationId: string;
  readonly purseId: string;
  readonly amountRial: bigint;
  /** The purse operation that registered the service (task 4-6). */
  readonly registerOperationId: string;
  readonly status: 'finalized' | 'reversed';
}

export interface ServiceReversals {
  /** The authorization, locked FOR UPDATE; null unless final or already reversed. */
  lockForReversal(authorizationId: string, tx: SqlExecutor): Promise<FinalizedService | null>;
  /** finalized → reversed, once; again changes nothing. */
  markReversed(
    actor: Actor,
    authorizationId: string,
    reason: string,
    tx: SqlExecutor,
  ): Promise<{ already: boolean }>;
}

export const SERVICE_REVERSALS = Symbol('SERVICE_REVERSALS');
