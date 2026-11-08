import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@sepehr/contracts';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { SETTLEMENT_ACTOR, SettlementService } from './settlement.service';

/**
 * Each final service becomes the doctor's payable and its fee (task 5-1), in the event's own
 * transaction; a redelivered event makes nothing more (the service's keys and the payable's
 * unique service).
 */
@Injectable()
export class SettlementConsumer implements EventConsumer, OnModuleInit {
  readonly name = 'settlement.payables';
  readonly eventTypes = ['service.finalized'];

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    private readonly settlement: SettlementService,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const { authorizationId } = event.payload as { authorizationId: string };
    await this.settlement.accrue(SETTLEMENT_ACTOR, authorizationId, tx);
  }
}
