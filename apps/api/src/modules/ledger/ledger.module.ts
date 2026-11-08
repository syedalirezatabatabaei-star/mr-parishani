import { Global, Module } from '@nestjs/common';
import { LEDGER } from '../../common/ledger/ledger.port';
import { LedgerBalanceApplier } from './balance-applier';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { ReconciliationReports } from './reconciliation-reports';

/**
 * The double-entry ledger (task 1-1, doc 02, ADR-004 and ADR-017). Global: the wallet and
 * the other financial modules post through the LEDGER port. Keeps account_balances from
 * its own events (task 1-4); the nightly LedgerReconciliation runs in the worker.
 */
@Global()
@Module({
  controllers: [LedgerController],
  providers: [
    LedgerService,
    { provide: LEDGER, useExisting: LedgerService },
    LedgerBalanceApplier,
    ReconciliationReports,
  ],
  exports: [LEDGER],
})
export class LedgerModule {}
