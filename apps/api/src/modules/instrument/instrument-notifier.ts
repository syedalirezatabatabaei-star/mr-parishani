import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { EventEnvelope } from '@sepehr/contracts';
import { and, eq, ne } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import type { Database } from '../../db/database.module';
import type { TextSmsSender } from '../../infra/sms-queue';
import { physicalDeliveryItems } from './instrument.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export const INSTRUMENT_SMS_SENDER = Symbol('INSTRUMENT_SMS_SENDER');

/** A shortage is not worth telling after three days. */
const TTL_MS = 3 * 86_400_000;

/**
 * Tells the case's owner what is missing from a delivery (doc 12 §3), by the items'
 * names only: never a cheque's or note's number (rule 27), never an amount. Run by the
 * worker; the mobile is read when sending, never logged (rule 30).
 */
@Injectable()
export class InstrumentNotifier implements EventConsumer, OnModuleInit, OnApplicationShutdown {
  readonly name = 'instrument.sms';
  readonly eventTypes = ['instrument.delivery_incomplete'];
  private readonly logger = new Logger(InstrumentNotifier.name);

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(INSTRUMENT_SMS_SENDER) private readonly sender: TextSmsSender,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async onApplicationShutdown() {
    await this.sender.close?.();
  }

  async handle(event: EventEnvelope, executor: SqlExecutor): Promise<void> {
    const tx = executor as Tx;
    const { deliveryId, creditApplicationId } = event.payload as {
      deliveryId: string;
      creditApplicationId: string;
    };
    const missing = await tx
      .select({ label: physicalDeliveryItems.label })
      .from(physicalDeliveryItems)
      .where(
        and(
          eq(physicalDeliveryItems.deliveryId, deliveryId),
          ne(physicalDeliveryItems.status, 'received'),
        ),
      );
    if (missing.length === 0) return;
    const facts = await this.credit.facts(creditApplicationId);
    if (!facts) return;
    const mobile = await this.leads.mobileOf(facts.patientPersonId, tx);
    if (mobile === null) {
      this.logger.warn(`no mobile for the owner of delivery ${deliveryId}; not sent`);
      return;
    }
    const templates = (await this.config.resolve('instrument.sms_templates')).value;
    const text = templates.deliveryIncomplete.replace(
      '{items}',
      missing.map((m) => m.label).join('، '),
    );
    await this.sender.sendText(
      { mobile, text, notAfter: new Date(Date.parse(event.occurredAt) + TTL_MS).toISOString() },
      `instrument-${event.id}`,
    );
  }
}
