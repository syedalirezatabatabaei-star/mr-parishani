import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';

/**
 * The doctor's funded patients (owner, پ۲; task 4-6), kept by the service module from
 * `wallet.funded`, so the doctor's list needs no new read in the wallet module. Ids and
 * the workplace's node path only (rule 30); a redelivered event adds nothing.
 */
@Injectable()
export class DoctorPatientsProjector implements EventConsumer, OnModuleInit {
  readonly name = 'service.doctor_patients';
  readonly eventTypes = ['wallet.funded', 'wallet.doctor_changed'];

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Inject(WALLET) private readonly wallet: WalletPort,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    if (event.type === 'wallet.doctor_changed') return this.moved(event, tx);
    const p = event.payload as { creditApplicationId: string; purseId: string };
    const facts = await this.credit.facts(p.creditApplicationId);
    if (!facts) return;
    const proforma = await this.proformas.proforma(facts.proformaId, tx);
    const workplace = proforma ? await this.workplaces.workplace(proforma.workplaceId, tx) : null;
    if (!workplace) return;
    const purse = await this.wallet.summary(p.purseId, tx);
    await tx.execute(sql`
      INSERT INTO service_doctor_patients (
        purse_id, credit_application_id, workplace_id, workplace_node_path, patient_person_id,
        funded_at
      ) VALUES (
        ${p.purseId}, ${p.creditApplicationId}, ${workplace.id}, ${workplace.nodePath},
        ${facts.patientPersonId}, ${purse.fundedAt ?? new Date(event.occurredAt)}
      )
      ON CONFLICT DO NOTHING
    `);
  }

  /** A doctor change (task 4-8): the purse now listed at the new doctor's workplace. */
  private async moved(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const p = event.payload as { purseId: string; workplaceId: string };
    const workplace = await this.workplaces.workplace(p.workplaceId, tx);
    if (!workplace) return;
    await tx.execute(sql`
      INSERT INTO service_purse_workplaces (purse_id, workplace_id, workplace_node_path, event_id)
      VALUES (${p.purseId}, ${workplace.id}, ${workplace.nodePath}, ${event.id})
      ON CONFLICT DO NOTHING
    `);
  }
}
