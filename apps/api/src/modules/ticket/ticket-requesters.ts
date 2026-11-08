import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type { TicketParties, TicketRequesters } from '../../common/ticket/ticket-requesters.port';
import { DATABASE, type Database } from '../../db/database.module';

/** TICKET_REQUESTERS (owner 1405/08/10): a ticket's requester and assignee, for the bell. */
@Injectable()
export class TicketRequesterDirectory implements TicketRequesters {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async partiesOf(ticketId: string, tx?: SqlExecutor): Promise<TicketParties | null> {
    const row = (
      await (tx ?? this.db).execute(sql`
        SELECT requester_account_id, requester_channel, assignee_account_id
        FROM tickets WHERE id = ${ticketId}
      `)
    ).rows[0];
    if (!row) return null;
    return {
      requesterAccountId: (row['requester_account_id'] as string | null) ?? null,
      channel: row['requester_channel'] as string,
      assigneeAccountId: (row['assignee_account_id'] as string | null) ?? null,
    };
  }
}
