import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  accountBalanceSchema,
  journalViewSchema,
  reconciliationRunSchema,
} from '@sepehr/contracts';
import { RequirePermission } from '../../common/auth/auth.decorators';
import type { PostedJournal } from '../../common/ledger/ledger.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { LedgerService } from './ledger.service';
import { ReconciliationReports } from './reconciliation-reports';

const runsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) });

const balanceQuerySchema = z.object({ at: z.iso.datetime({ offset: true }).optional() });

/** Amounts leave as strings of rials: JSON has no bigint, and a number would lose digits. */
const journalView = (j: PostedJournal) => ({
  id: j.id,
  entityId: j.entityId,
  eventType: j.eventType,
  occurredAt: j.occurredAt.toISOString(),
  caseId: j.caseId,
  creditApplicationId: j.creditApplicationId,
  reversesJournalEntryId: j.reversesJournalEntryId,
  reason: j.reason,
  createdBy: j.createdBy,
  createdAt: j.createdAt.toISOString(),
  lines: j.lines.map((l) => ({
    id: l.id,
    accountId: l.accountId,
    direction: l.direction,
    amountRial: l.amountRial.toString(),
  })),
});

/**
 * Reading the ledger (task 1-1). Nothing is written through the API: modules post through
 * the LEDGER port as part of their own operations.
 */
@Controller('ledger')
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly reconciliation: ReconciliationReports,
  ) {}

  /** The latest nightly reconciliation runs, with discrepancies and daily reports (task 1-4). */
  @RequirePermission('ledger.read')
  @Get('reconciliation/runs')
  @ZodResponse(z.array(reconciliationRunSchema))
  runs(@Query(new ZodBody(runsQuerySchema)) query: z.output<typeof runsQuerySchema>) {
    return this.reconciliation.latest(query.limit);
  }

  @RequirePermission('ledger.read')
  @Get('journals/:id')
  @ZodResponse(journalViewSchema)
  async journal(@Param('id', new ParseUUIDPipe()) id: string) {
    const journal = await this.ledger.getJournal(id);
    if (!journal) throw new NotFoundException();
    return journalView(journal);
  }

  @RequirePermission('ledger.read')
  @Get('accounts/:id/balance')
  @ZodResponse(accountBalanceSchema)
  async balance(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(balanceQuerySchema)) query: z.output<typeof balanceQuerySchema>,
  ) {
    const b = await this.ledger.balanceOf(
      id,
      query.at === undefined ? undefined : new Date(query.at),
    );
    return {
      accountId: b.accountId,
      debitRial: b.debitRial.toString(),
      creditRial: b.creditRial.toString(),
      netDebitRial: b.netDebitRial.toString(),
    };
  }
}
