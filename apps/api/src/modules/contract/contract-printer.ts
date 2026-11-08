import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@sepehr/contracts';
import { eq } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  EVENT_CONSUMERS,
  OUTBOX,
  type EventConsumer,
  type EventConsumerRegistry,
  type OutboxPort,
} from '../../common/events/outbox.port';
import { PDF_RENDERER, type PdfRenderer } from '../../common/pdf/pdf-renderer.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import type { Database } from '../../db/database.module';
import { contractHtml, type ShownInstallment } from './contract-html';
import { contracts } from './contract.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Prints a requested contract (task 4-1; doc 12 §2), in the worker: the locked template
 * version filled with the contract's values, to a PDF (PDF_RENDERER, ADR-033), stored in
 * private space under a generated key with its SHA-256. Once; a contract already printed is
 * left as it is. A template that cannot be laid out fails the contract; a renderer or
 * storage error is thrown, so the outbox tries again.
 */
@Injectable()
export class ContractPrinter implements EventConsumer, OnModuleInit {
  readonly name = 'contract.printer';
  readonly eventTypes = ['contract.requested'];
  private readonly logger = new Logger(ContractPrinter.name);

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(PDF_RENDERER) private readonly renderer: PdfRenderer,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, executor: SqlExecutor): Promise<void> {
    const tx = executor as Tx;
    const { contractId } = event.payload as { contractId: string };
    const [row] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .for('update');
    if (row?.status !== 'generating') return;

    let html: string;
    try {
      const template = await this.config.getVersion(
        'contract.loan_template',
        row.templateVersionId,
      );
      const installments = JSON.parse(
        row.fields['installments.table'] ?? '[]',
      ) as ShownInstallment[];
      html = contractHtml(template.value, row.fields, installments);
    } catch (error) {
      const failure = (error as Error).message.slice(0, 500);
      this.logger.warn(`contract ${row.id} cannot be laid out: ${failure}`);
      await tx.update(contracts).set({ status: 'failed', failure }).where(eq(contracts.id, row.id));
      await this.publish(tx, 'contract.failed', row.id, row.creditApplicationId);
      return;
    }

    const pdf = await this.renderer.render(html);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const storageKey = `contracts/${row.id}/${sha256.slice(0, 16)}.pdf`;
    await this.storage.put('private', storageKey, pdf, 'application/pdf');
    await tx
      .update(contracts)
      .set({ status: 'ready', storageKey, sha256, sizeBytes: pdf.length, generatedAt: new Date() })
      .where(eq(contracts.id, row.id));
    await this.publish(tx, 'contract.generated', row.id, row.creditApplicationId);
  }

  private async publish(tx: Tx, type: string, contractId: string, creditApplicationId: string) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'contract',
        aggregateId: contractId,
        payload: { contractId, creditApplicationId },
      },
      tx,
    );
  }
}
