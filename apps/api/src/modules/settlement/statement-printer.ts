import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { PDF_RENDERER, type PdfRenderer } from '../../common/pdf/pdf-renderer.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { statementPdfKey } from './panel.service';
import { statementHtml, type PrintedStatement } from './statement-html';

/**
 * Prints a paid statement (task 5-6; doc 06 §5 step 6; doc 14 ث), in the worker: Jalali
 * only, the font inline, stored in private space under its id and hash, the SHA-256 kept on
 * the statement. Once: a statement already printed is left as it is. A renderer or storage
 * error is thrown, so the outbox tries again.
 */
@Injectable()
export class StatementPrinter implements EventConsumer, OnModuleInit {
  readonly name = 'settlement.statement_printer';
  readonly eventTypes = ['settlement.statement_paid'];

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(PDF_RENDERER) private readonly renderer: PdfRenderer,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const { statementId } = event.payload as { statementId: string };
    const s = (
      await tx.execute(sql`
        SELECT id, status, period_year, period_month, gross_credit_services_rial::text AS gross,
               credit_fees_rial::text AS credit_fees, cash_fees_rial::text AS cash_fees,
               carried_in_rial::text AS carried_in, other_deductions_rial::text AS other,
               payable_rial::text AS payable, carried_out_rial::text AS carried_out, pdf_hash
        FROM settlement_statements WHERE id = ${statementId} FOR UPDATE
      `)
    ).rows[0];
    if (s?.['status'] !== 'paid' || s['pdf_hash'] !== null) return;

    const html = statementHtml(await this.facts(tx, statementId, s));
    const pdf = await this.renderer.render(html);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    await this.storage.put('private', statementPdfKey(statementId, sha256), pdf, 'application/pdf');
    await tx.execute(
      sql`UPDATE settlement_statements SET pdf_hash = ${sha256} WHERE id = ${statementId}`,
    );
  }

  private async facts(
    tx: SqlExecutor,
    id: string,
    s: Record<string, unknown>,
  ): Promise<PrintedStatement> {
    const items = await tx.execute(sql`
      SELECT l.line_type, l.amount_rial::text AS amount,
             coalesce(p.finalized_at, fp.finalized_at,
                      (c.service_date::timestamp AT TIME ZONE 'Asia/Tehran')) AS occurred_at,
             coalesce(p.workplace_id, fp.workplace_id, c.workplace_id) AS workplace_id
      FROM settlement_statement_lines l
      LEFT JOIN doctor_payables p ON l.ref_type = 'doctor_payable' AND p.id = l.ref_id
      LEFT JOIN service_fees f ON l.ref_type = 'service_fee' AND f.id = l.ref_id
      LEFT JOIN doctor_payables fp ON fp.id = f.doctor_payable_id
      LEFT JOIN cash_services c ON c.id = f.cash_service_id
      WHERE l.statement_id = ${id} AND l.line_type IN ('credit_service', 'credit_fee', 'cash_fee')
      ORDER BY 3, l.line_type, l.ref_id
    `);
    const payouts = await tx.execute(sql`
      SELECT iban_last4, paid_on::text AS paid_on, bank_tracking_ref, amount_rial::text AS amount
      FROM payout_orders WHERE statement_id = ${id} AND status = 'confirmed' ORDER BY confirmed_at
    `);
    const workplaceId = items.rows.find((r) => r['workplace_id'])?.['workplace_id'] as
      string | undefined;
    const workplace = workplaceId ? await this.workplaces.workplace(workplaceId, tx) : null;
    return {
      doctorName: workplace?.doctorName ?? '',
      periodYear: s['period_year'] as number,
      periodMonth: s['period_month'] as number,
      grossRial: BigInt(s['gross'] as string),
      creditFeesRial: BigInt(s['credit_fees'] as string),
      cashFeesRial: BigInt(s['cash_fees'] as string),
      carriedInRial: BigInt(s['carried_in'] as string),
      otherDeductionsRial: BigInt(s['other'] as string),
      payableRial: BigInt(s['payable'] as string),
      carriedOutRial: BigInt(s['carried_out'] as string),
      items: items.rows.map((r) => ({
        kind: r['line_type'] as 'credit_service' | 'credit_fee' | 'cash_fee',
        occurredAt: new Date(r['occurred_at'] as string),
        amountRial: BigInt(r['amount'] as string),
      })),
      payouts: payouts.rows.map((r) => ({
        ibanLast4: r['iban_last4'] as string,
        // The Tehran day it was paid, at noon: its Jalali day.
        paidOn: new Date(`${r['paid_on'] as string}T08:30:00Z`),
        bankTrackingRef: r['bank_tracking_ref'] as string,
        amountRial: BigInt(r['amount'] as string),
      })),
    };
  }
}
