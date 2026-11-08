import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@sepehr/contracts';
import { and, asc, eq } from 'drizzle-orm';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import { LeadIntakeService, type IntakeSettings } from './intake.service';
import { IMPORT_ROW_NATIONAL_ID, LEAD_CRYPTO, type LeadCrypto } from './lead.crypto';
import { leadImportBatches, leadImportRows } from './lead.schema';

/**
 * Processes a committed import batch in the worker (doc 05 §8: in a queue, never in the
 * request): on `lead.import_committed`, every valid row goes through the one intake, each
 * in its own transaction. A row is done once: a redelivered event, or a run after a crash,
 * skips the rows already processed. A batch cancelled meanwhile stops at the next row.
 */
@Injectable()
export class LeadImportProcessor implements EventConsumer, OnModuleInit {
  readonly name = 'lead.import_processor';
  readonly eventTypes = ['lead.import_committed'] as const;
  private readonly logger = new Logger(LeadImportProcessor.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(LEAD_CRYPTO) private readonly crypto: LeadCrypto,
    private readonly intake: LeadIntakeService,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  /** Rows run in their own transactions, not the dispatcher's: see process(). */
  async handle(event: EventEnvelope): Promise<void> {
    const { batchId } = event.payload as { batchId: string };
    await this.process(batchId);
  }

  /** Every row still to do; returns how many were processed and how many failed. */
  async process(batchId: string): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const pending = await this.db
      .select({ id: leadImportRows.id })
      .from(leadImportRows)
      .where(and(eq(leadImportRows.batchId, batchId), eq(leadImportRows.status, 'valid')))
      .orderBy(asc(leadImportRows.rowNumber));
    const settings = await this.intake.settings();
    for (const { id } of pending) {
      const outcome = await this.processRow(batchId, id, settings).catch((error: unknown) => {
        // Ids and the error text only (rule 30).
        this.logger.error(
          `import ${batchId} row ${id} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        return 'failed' as const;
      });
      if (outcome === 'stopped') return { processed, failed };
      if (outcome === 'failed') {
        failed++;
        await this.db
          .update(leadImportRows)
          .set({ status: 'failed', errors: ['processing_failed'], processedAt: new Date() })
          .where(and(eq(leadImportRows.id, id), eq(leadImportRows.status, 'valid')));
      } else if (outcome === 'processed') {
        processed++;
      }
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(leadImportBatches)
        .set({ status: 'processed', processedAt: new Date() })
        .where(and(eq(leadImportBatches.id, batchId), eq(leadImportBatches.status, 'committed')));
    });
    return { processed, failed };
  }

  private processRow(
    batchId: string,
    rowId: string,
    settings: IntakeSettings,
  ): Promise<'processed' | 'skipped' | 'stopped'> {
    return this.db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(leadImportBatches)
        .where(eq(leadImportBatches.id, batchId))
        .for('update');
      if (batch?.status !== 'committed') return 'stopped';
      const [row] = await tx
        .select()
        .from(leadImportRows)
        .where(eq(leadImportRows.id, rowId))
        .for('update');
      if (row?.status !== 'valid' || !row.mobile || !row.treatmentFieldCode) return 'skipped';
      const result = await this.intake.intakeIn(
        tx,
        {
          accountId: batch.committedBy,
          sessionId: null,
          ip: null,
          roles: ['lead.import'],
        },
        {
          mobile: row.mobile,
          name: row.name,
          nationalId:
            row.nationalIdEnc === null
              ? null
              : this.crypto.fieldCrypto.decrypt(row.nationalIdEnc, IMPORT_ROW_NATIONAL_ID),
          treatmentFieldCode: row.treatmentFieldCode,
          cityCode: row.cityCode,
          channel: 'excel',
          smsConsent: row.smsConsent,
          importBatchId: batchId,
        },
        settings,
      );
      await tx
        .update(leadImportRows)
        .set({
          status: 'processed',
          intakeId: result.intakeId,
          caseId: result.caseId,
          personId: result.personId,
          createdPerson: result.personCreated,
          processedAt: new Date(),
        })
        .where(eq(leadImportRows.id, row.id));
      return 'processed';
    });
  }
}
