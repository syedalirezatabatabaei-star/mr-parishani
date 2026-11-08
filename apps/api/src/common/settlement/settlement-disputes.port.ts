import type { DisputeStatus, DisputeSubject } from '@sepehr/contracts';
import type { Actor, SqlExecutor } from '../audit/audit.port';
import type { EffectiveAccess } from '../auth/access.port';

/**
 * Port to the settlement module's financial disputes (task 5-2) for the ticket module's
 * financial complaints (task 7-2; doc 17 §1; owner ج۳). The settlement module provides it
 * under {@link SETTLEMENT_DISPUTES}; the ticket module never reads its tables.
 */
export interface SettlementDisputes {
  /**
   * Opens a dispute exactly as `POST /settlement/disputes` does (the caller's permission and
   * reach, the item and its sibling held), in the caller's transaction, with its ticket.
   * A refusal throws (409 not_holdable, dispute_open, statement_approved; 404 item_not_found).
   */
  openForTicket(
    tx: SqlExecutor,
    actor: Actor,
    access: EffectiveAccess,
    input: { subjectType: DisputeSubject; subjectId: string; reason: string },
    ticketId: string,
  ): Promise<string>;
  /** The dispute's state, or null. */
  statusOf(disputeId: string, tx?: SqlExecutor): Promise<DisputeStatus | null>;
  /** A label for an item the caller may dispute, or null (read only). */
  itemLabel(access: EffectiveAccess, type: DisputeSubject, id: string): Promise<string | null>;
}

export const SETTLEMENT_DISPUTES = Symbol('SETTLEMENT_DISPUTES');
