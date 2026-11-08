import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';

/**
 * Keeps account_balances up to date (doc 02 §2, task 1-4): on each ledger.journal_posted,
 * adds the journal's entries to their accounts' rows, in the consumer's transaction, and
 * records the journal in ledger_balance_applications. Together with processed_events this
 * makes a redelivered event a no-op; the application row also lets the nightly
 * reconciliation compare only what has been applied.
 */
@Injectable()
export class LedgerBalanceApplier implements EventConsumer, OnModuleInit {
  readonly name = 'ledger.balances';
  readonly eventTypes = ['ledger.journal_posted'] as const;

  constructor(@Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const { journalEntryId } = event.payload as { journalEntryId: string };
    const claimed = await tx.execute(sql`
      INSERT INTO ledger_balance_applications (journal_entry_id) VALUES (${journalEntryId})
      ON CONFLICT (journal_entry_id) DO NOTHING
      RETURNING id
    `);
    if (claimed.rows.length === 0) return;
    await tx.execute(sql`
      INSERT INTO account_balances (account_id, entity_id, debit_rial, credit_rial)
      SELECT e.account_id, a.entity_id,
             coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'debit'), 0),
             coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'credit'), 0)
      FROM ledger_entries e
      JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.journal_entry_id = ${journalEntryId}
      GROUP BY e.account_id, a.entity_id
      ON CONFLICT (account_id) DO UPDATE
        SET debit_rial = account_balances.debit_rial + EXCLUDED.debit_rial,
            credit_rial = account_balances.credit_rial + EXCLUDED.credit_rial
    `);
  }
}
