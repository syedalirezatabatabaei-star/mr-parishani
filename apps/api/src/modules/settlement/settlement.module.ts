import { Global, Module } from '@nestjs/common';
import { SETTLEMENT_REFUNDS } from '../../common/settlement/settlement-refunds.port';
import { FieldCrypto } from '../../security/field-crypto';
import { keyRingFromEnv } from '../../security/key-ring';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { CashServiceController } from './cash-service.controller';
import { CashServiceService } from './cash-service.service';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { SettlementPanelController } from './panel.controller';
import { SettlementPanelService } from './panel.service';
import { FeeTicketLink, PayableTicketLink, StatementTicketLink } from './ticket-link';
import { SETTLEMENT_DISPUTES } from '../../common/settlement/settlement-disputes.port';
import { PayoutController } from './payout.controller';
import { PayoutService, SETTLEMENT_CRYPTO } from './payout.service';
import { SettlementReencryption } from './settlement.reencryption';
import { SettlementRefundsDirectory } from './settlement-refunds.directory';
import { SettlementService } from './settlement.service';
import { StatementController } from './statement.controller';
import { StatementService } from './statement.service';

/**
 * A doctor's settlement (doc 06; phase 5). Task 5-1: each final service becomes the doctor's
 * payable and its fee (SettlementService); the worker runs its consumer, the daily move to
 * due and the nightly reconciliation. Task 5-2: financial disputes hold an item out of every
 * payment (DisputeService). Task 5-3: cash services and their fee (CashServiceService).
 * Task 5-4: doctors' monthly statements (StatementService; the worker makes the drafts).
 * Task 5-5: review, approval and payout orders (PayoutService); the Sheba snapshot is
 * encrypted with FIELD_ENCRYPTION_KEY's ring (rule 27; R4, ADR-040: every key reads, the
 * active one writes, and SettlementReencryption rewrites it under the active key). Task 5-6:
 * the doctor's panel, read only (SettlementPanelService); the worker prints a paid statement's
 * PDF. Task 5-7: accounting's reports and the Odoo export (AccountingService).
 */
@Global()
@Module({
  controllers: [
    DisputeController,
    CashServiceController,
    StatementController,
    PayoutController,
    SettlementPanelController,
    AccountingController,
  ],
  providers: [
    SettlementService,
    DisputeService,
    CashServiceService,
    StatementService,
    PayoutService,
    SettlementPanelService,
    // A ticket's link to a statement (task 7-1), through the panel's own rule.
    StatementTicketLink,
    // Task 7-2: financial complaints hold their item through 5-2's disputes.
    PayableTicketLink,
    FeeTicketLink,
    { provide: SETTLEMENT_DISPUTES, useExisting: DisputeService },
    AccountingService,
    // Task 5-2b: read only, for the down payments' reconciliation (4-6b).
    SettlementRefundsDirectory,
    { provide: SETTLEMENT_REFUNDS, useExisting: SettlementRefundsDirectory },
    {
      provide: SETTLEMENT_CRYPTO,
      useFactory: () => new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY')),
    },
    // R4 (ADR-040): the Sheba snapshot of every order under the active key, by hand only.
    SettlementReencryption,
  ],
  exports: [SettlementService, SETTLEMENT_REFUNDS, SETTLEMENT_DISPUTES],
})
export class SettlementModule {}
