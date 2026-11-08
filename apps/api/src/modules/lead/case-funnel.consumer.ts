import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CASE_FUNNEL_TARGETS, type EventEnvelope } from '@sepehr/contracts';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { CaseService } from './case.service';
import { systemActor, type Tx } from './lead.shared';

type FunnelEvent = keyof typeof CASE_FUNNEL_TARGETS;

const FUNNEL_ACTOR = systemActor('lead.case_funnel');

/**
 * The case funnel (owner 1405/07/23, question 8): an appointment confirmed, an appointment
 * examined and a proforma issued bring their case to `appointment_booked`, `examined` and
 * `proforma_issued`, through CaseService (see advanceFunnel). Everything comes from the
 * event's payload: lead never reads booking's or proforma's tables. Once per event, by
 * processed_events in the same transaction; an appointment without a case is left alone.
 */
@Injectable()
export class CaseFunnelConsumer implements EventConsumer, OnModuleInit {
  readonly name = 'lead.case_funnel';
  readonly eventTypes = Object.keys(CASE_FUNNEL_TARGETS) as FunnelEvent[];

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    private readonly cases: CaseService,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const { caseId } = event.payload as { caseId?: string | null };
    if (!caseId) return;
    await this.cases.advanceFunnel(tx as Tx, FUNNEL_ACTOR, {
      caseId,
      eventType: event.type as FunnelEvent,
      eventId: event.id,
    });
  }
}
