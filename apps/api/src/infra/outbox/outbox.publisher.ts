import { Inject, Injectable, Optional } from '@nestjs/common';
import { DOMAIN_EVENTS, EVENT_TYPE_FORMAT } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type { NewEvent, OutboxPort } from '../../common/events/outbox.port';

/**
 * Replaces DOMAIN_EVENTS, for tests that need event types of their own. Never provided
 * in the application.
 */
export const OUTBOX_EVENT_REGISTRY = Symbol('OUTBOX_EVENT_REGISTRY');
export type EventRegistry = Readonly<Record<string, z.ZodType>>;

/** Writes events into outbox_events, inside the caller's transaction. */
@Injectable()
export class OutboxPublisher implements OutboxPort {
  private readonly registry: EventRegistry;

  constructor(@Optional() @Inject(OUTBOX_EVENT_REGISTRY) registry?: EventRegistry) {
    this.registry = registry ?? DOMAIN_EVENTS;
  }

  async publish(event: NewEvent, tx: SqlExecutor): Promise<string> {
    if (!EVENT_TYPE_FORMAT.test(event.type)) throw new Error(`malformed event type ${event.type}`);
    const schema = this.registry[event.type];
    if (!schema) throw new Error(`unknown event type ${event.type}`);
    const parsed = schema.safeParse(event.payload);
    // Names the paths only: a payload value must never reach a log (rule 30).
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
      throw new Error(`payload of ${event.type} does not match its schema at: ${paths}`);
    }
    // Key order is irrelevant here: jsonb stores the value, not the text.
    const payloadJson = JSON.stringify(parsed.data);
    const result = await tx.execute(sql`
      INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
      VALUES (${event.type}, ${event.aggregateType}, ${event.aggregateId}, ${payloadJson}::jsonb)
      RETURNING id
    `);
    const [row] = result.rows as { id: string }[];
    if (!row) throw new Error('outbox insert returned nothing');
    return row.id;
  }
}
