import { Inject, Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EventConsumer, EventConsumerRegistry } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';

/**
 * Hands an event to every consumer subscribed to its type. Each consumer runs in its own
 * transaction, which first claims (event, consumer) in processed_events: if another
 * delivery already committed that claim, the consumer is skipped. So a consumer's effect
 * happens exactly once however often the event arrives, and one failing consumer does
 * not redo the others when the job is retried.
 */
@Injectable()
export class EventDispatcher implements EventConsumerRegistry {
  private readonly consumers = new Map<string, EventConsumer>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  register(consumer: EventConsumer): void {
    if (this.consumers.has(consumer.name)) {
      throw new Error(`event consumer ${consumer.name} is registered twice`);
    }
    this.consumers.set(consumer.name, consumer);
  }

  /** The consumers an event of `type` goes to (asked by the outbox re-queue, task 10-2). */
  subscribersOf(type: string): string[] {
    return [...this.consumers.values()]
      .filter((c) => c.eventTypes.includes(type))
      .map((c) => c.name);
  }

  /** Names of the consumers that took effect now (not those skipped as done). */
  async dispatch(event: EventEnvelope): Promise<string[]> {
    const applied: string[] = [];
    for (const consumer of this.consumers.values()) {
      if (!consumer.eventTypes.includes(event.type)) continue;
      const ran = await this.db.transaction(async (tx) => {
        const claim = await tx.execute(sql`
          INSERT INTO processed_events (event_id, consumer, event_created_at)
          VALUES (${event.id}, ${consumer.name}, ${event.occurredAt}::timestamptz)
          ON CONFLICT (event_id, consumer, event_created_at) DO NOTHING
          RETURNING id
        `);
        if (claim.rows.length === 0) return false;
        await consumer.handle(event, tx);
        return true;
      });
      if (ran) applied.push(consumer.name);
    }
    return applied;
  }
}
