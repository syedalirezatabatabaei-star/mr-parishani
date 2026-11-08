import type { SqlExecutor } from '../audit/audit.port';

/**
 * Port to the ticket module (owner 1405/08/10, the bell): who asked a ticket, and who works
 * it now; ids only, never its text.
 */
export interface TicketParties {
  readonly requesterAccountId: string | null;
  /** `patient`, `center`, `staff` or `internal`. */
  readonly channel: string;
  readonly assigneeAccountId: string | null;
}

export interface TicketRequesters {
  partiesOf(ticketId: string, tx?: SqlExecutor): Promise<TicketParties | null>;
}

export const TICKET_REQUESTERS = Symbol('TICKET_REQUESTERS');
