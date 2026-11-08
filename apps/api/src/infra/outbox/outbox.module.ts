import { Global, Module } from '@nestjs/common';
import { EVENT_CONSUMERS, OUTBOX } from '../../common/events/outbox.port';
import { EventDispatcher } from './event-dispatcher';
import { OutboxPublisher } from './outbox.publisher';

/**
 * The transactional outbox (ADR-005, task 0-7). Global: any module publishes events
 * through OUTBOX and registers its consumers with EVENT_CONSUMERS.
 */
@Global()
@Module({
  providers: [
    OutboxPublisher,
    { provide: OUTBOX, useExisting: OutboxPublisher },
    EventDispatcher,
    { provide: EVENT_CONSUMERS, useExisting: EventDispatcher },
  ],
  exports: [OUTBOX, EVENT_CONSUMERS, EventDispatcher],
})
export class OutboxModule {}
