import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { formatToman, type EventEnvelope } from '@sepehr/contracts';
import { eq } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import type { Database } from '../../db/database.module';
import type { TextSmsSender } from '../../infra/sms-queue';
import { creditApplications, creditDocuments, creditGuarantors } from './credit.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export const CREDIT_SMS_SENDER = Symbol('CREDIT_SMS_SENDER');

/** Fills {name} placeholders; unknown ones stay as written (as booking's SMS do). */
const render = (template: string, values: Readonly<Record<string, string>>) =>
  template.replace(/\{([a-z]+)\}/g, (whole, name: string) => values[name] ?? whole);

/** An invitation is not worth sending after a week. */
const INVITATION_TTL_MS = 7 * 86_400_000;

/**
 * Credit SMS from the outbox (task 3-5 part B), run by the worker. A guarantor's
 * invitation says only the commitment, in tomans (doc 10 §5): never the treatment, the
 * doctor, the center or a score; a decision (task 3-6) tells the patient what, never why.
 * The mobile is read when sending, never logged (rule 30).
 */
@Injectable()
export class CreditNotifier implements EventConsumer, OnModuleInit, OnApplicationShutdown {
  readonly name = 'credit.sms';
  readonly eventTypes = ['credit.guarantor_invited', 'credit.document_rejected', 'credit.decided'];
  private readonly logger = new Logger(CreditNotifier.name);

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(CREDIT_SMS_SENDER) private readonly sender: TextSmsSender,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async onApplicationShutdown() {
    await this.sender.close?.();
  }

  async handle(event: EventEnvelope, executor: SqlExecutor): Promise<void> {
    const tx = executor as Tx;
    if (event.type === 'credit.document_rejected') return this.documentRejected(event, tx);
    if (event.type === 'credit.decided') return this.decided(event, tx);
    const { guarantorId } = event.payload as { guarantorId: string };
    const [row] = await tx
      .select({ g: creditGuarantors, total: creditApplications.totalObligationRial })
      .from(creditGuarantors)
      .innerJoin(
        creditApplications,
        eq(creditApplications.id, creditGuarantors.creditApplicationId),
      )
      .where(eq(creditGuarantors.id, guarantorId));
    if (!row || row.g.status === 'withdrawn') return;
    const mobile = await this.leads.mobileOf(row.g.personId, tx);
    if (mobile === null) {
      this.logger.warn(`no mobile for guarantor ${row.g.id}; invitation not sent`);
      return;
    }
    const templates = await this.config.resolve('credit.sms_templates');
    // {amount} is the whole amount with its unit, exact (ADR-035). A template that still
    // writes «{amount} تومان» (the seeded one) is read the same, never with the unit twice.
    const template = templates.value.guarantorInvited.replace('{amount} تومان', '{amount}');
    const text = render(template, { amount: formatToman(row.total) });
    await this.sender.sendText(
      {
        mobile,
        text,
        notAfter: new Date(Date.parse(event.occurredAt) + INVITATION_TTL_MS).toISOString(),
      },
      `credit-${event.id}`,
    );
  }

  /** A decision, to the patient: what it is, never why or a score (doc 10 §6; task 3-6). */
  private async decided(event: EventEnvelope, tx: Tx): Promise<void> {
    const { creditApplicationId, outcome } = event.payload as {
      creditApplicationId: string;
      outcome: 'approved' | 'conditional' | 'rejected' | 'needs_more_guarantors';
    };
    const [app] = await tx
      .select({ personId: creditApplications.patientPersonId })
      .from(creditApplications)
      .where(eq(creditApplications.id, creditApplicationId));
    if (!app) return;
    const mobile = await this.leads.mobileOf(app.personId, tx);
    if (mobile === null) {
      this.logger.warn(`no mobile for the patient of application ${creditApplicationId}; not sent`);
      return;
    }
    const templates = (await this.config.resolve('credit.decision_sms_templates')).value;
    const text =
      outcome === 'needs_more_guarantors' ? templates.needsMoreGuarantors : templates[outcome];
    await this.sender.sendText(
      {
        mobile,
        text,
        notAfter: new Date(Date.parse(event.occurredAt) + INVITATION_TTL_MS).toISOString(),
      },
      `credit-${event.id}`,
    );
  }

  /** A rejected document: its owner is told which one, never why (the reason is in the panel). */
  private async documentRejected(event: EventEnvelope, tx: Tx): Promise<void> {
    const { documentId } = event.payload as { documentId: string };
    const [doc] = await tx.select().from(creditDocuments).where(eq(creditDocuments.id, documentId));
    if (doc?.status !== 'rejected') return;
    const mobile = await this.leads.mobileOf(doc.personId, tx);
    if (mobile === null) {
      this.logger.warn(`no mobile for the owner of document ${doc.id}; not sent`);
      return;
    }
    const [checklist, templates] = await Promise.all([
      this.config.getVersion('credit.document_checklist', doc.checklistVersionId),
      this.config.resolve('credit.document_sms_templates'),
    ]);
    const title = checklist.value.items.find((i) => i.code === doc.itemCode)?.title ?? doc.itemCode;
    await this.sender.sendText(
      {
        mobile,
        text: render(templates.value.documentRejected, { document: title }),
        notAfter: new Date(Date.parse(event.occurredAt) + INVITATION_TTL_MS).toISOString(),
      },
      `credit-${event.id}`,
    );
  }
}
