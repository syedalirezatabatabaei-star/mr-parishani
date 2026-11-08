import type { EventEnvelope } from '@sepehr/contracts';
import type { SqlExecutor } from '../audit/audit.port';

/**
 * Domain events through the transactional outbox (ADR-005, task 0-7). A module never
 * sends a message or touches a queue as part of a change: it publishes an event in the
 * change's own transaction, and the worker delivers it after the commit. A rolled-back
 * change leaves no event; a committed one is never lost.
 */

export interface NewEvent {
  /** A type registered in DOMAIN_EVENTS (@sepehr/contracts). */
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Validated against the type's schema. Ids and amounts, never personal data. */
  readonly payload: unknown;
}

export interface OutboxPort {
  /** Writes the event in `tx`; returns its id. */
  publish(event: NewEvent, tx: SqlExecutor): Promise<string>;
}

export const OUTBOX = Symbol('OUTBOX');

/**
 * Something that reacts to domain events. The dispatcher records each (event, consumer)
 * in processed_events in the same transaction as `handle`, so an event delivered twice
 * takes effect once. Events may arrive out of order.
 */
export interface EventConsumer {
  /** Stable and unique: it is the idempotency key with the event id. `module.name`. */
  readonly name: string;
  readonly eventTypes: readonly string[];
  handle(event: EventEnvelope, tx: SqlExecutor): Promise<void>;
}

/** Where modules register their consumers, in onModuleInit. */
export interface EventConsumerRegistry {
  register(consumer: EventConsumer): void;
}

export const EVENT_CONSUMERS = Symbol('EVENT_CONSUMERS');
