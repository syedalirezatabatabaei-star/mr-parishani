import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { toPersianDigits, type EventEnvelope } from '@sepehr/contracts';
import type { Actor, SqlExecutor } from '../../common/audit/audit.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { TicketService } from './ticket.service';

const SYSTEM: Actor = { accountId: null, sessionId: null, ip: null, roles: ['system'] };

/**
 * A patient's dispute of a proforma becomes a ticket (doc 10 §2, doc 17 §1; task 7-1): once per
 * proforma, with the patient's note, linked to it, for the unit of the `proforma_dispute`
 * topic. The proforma module's own record (support_requests, task 3-4) is left as it is.
 */
@Injectable()
export class ProformaDisputeTickets implements EventConsumer, OnModuleInit {
  readonly name = 'ticket.proforma_disputes';
  readonly eventTypes = ['proforma.disputed'] as const;

  constructor(
    private readonly tickets: TicketService,
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    // The proforma module's port in the API, the worker's own provider there: resolved
    // wherever it is, when first used.
    private readonly moduleRef: ModuleRef,
  ) {}

  private get proformas(): ProformaDirectory {
    return this.moduleRef.get<ProformaDirectory>(PROFORMA_DIRECTORY, { strict: false });
  }

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const proformaId = (event.payload as { proformaId: string }).proformaId;
    const proforma = await this.proformas.proforma(proformaId, tx);
    if (!proforma) return;
    await this.tickets.openFromProformaDispute(
      tx,
      SYSTEM,
      {
        proformaId,
        personId: proforma.personId,
        version: proforma.version,
        note: proforma.patientResponseNote,
        label: `پیش‌فاکتور، نسخه ${toPersianDigits(String(proforma.version))}`,
      },
      new Date(event.occurredAt),
    );
  }
}

/**
 * A financial complaint ends with its dispute (doc 17 §1; task 7-2): when accounting decides
 * the dispute (task 5-2), the complaint is resolved and the requester told the outcome; once.
 */
@Injectable()
export class DisputeDecidedTickets implements EventConsumer, OnModuleInit {
  readonly name = 'ticket.dispute_decided';
  readonly eventTypes = ['settlement.dispute_resolved'] as const;

  constructor(
    private readonly tickets: TicketService,
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const { disputeId, status } = event.payload as { disputeId: string; status: string };
    await this.tickets.resolveFromDispute(tx, disputeId, status, new Date(event.occurredAt));
  }
}
