import { Global, Module } from '@nestjs/common';
import { COMPLETION_REFUNDS } from '../../common/contract/completion-refunds.port';
import { CONTRACT_TERMS } from '../../common/contract/contract-terms.port';
import { ContractTermsService } from './contract-terms.service';
import { COMPLETION_STATUS } from '../../common/contract/completion-status.port';
import { CompletionRefundService } from './completion-refund.service';
import { RefundPaymentController } from './refund-payment.controller';
import { RefundPaymentService } from './refund-payment.service';
import { PAYMENT_PROVIDER } from '../../common/payment/payment-provider.port';
import { CompletionController, MyCompletionController } from './completion.controller';
import { CompletionService } from './completion.service';
import { ManualReceiptProvider } from './manual-receipt.provider';
import { ContractTemplateGuard } from './contract-template.guard';
import { ContractController, PartyContractController } from './contract.controller';
import { ContractService } from './contract.service';
import { DownPaymentService } from './down-payment.service';
import { OriginationDiscountController } from './origination-discount.controller';
import { OriginationDiscountService } from './origination-discount.service';
import { OriginationFeeService } from './origination-fee.service';

/**
 * Loan contracts (doc 12 §2; task 4-1): the template's guard, asking for a contract, the
 * parties' acceptance. Reads the credit application through CREDIT_CONTRACT_FACTS and the
 * persons through LEAD_CASES. The worker prints them (ContractPrinter, ADR-033). Task 4-3
 * brings completion and its receipts (CompletionService), posting through LEDGER only.
 * Task 4-5: the down payment's posting (ADR-034) and COMPLETION_STATUS, which funding reads.
 */
@Global()
@Module({
  controllers: [
    ContractController,
    PartyContractController,
    CompletionController,
    MyCompletionController,
    RefundPaymentController,
    OriginationDiscountController,
  ],
  providers: [
    ContractService,
    ContractTemplateGuard,
    CompletionService,
    // ADR-048: the origination fee's waiver and discount.
    OriginationFeeService,
    OriginationDiscountService,
    // ADR-009: the manual receipt, the only provider of version one.
    ManualReceiptProvider,
    { provide: PAYMENT_PROVIDER, useExisting: ManualReceiptProvider },
    DownPaymentService,
    { provide: COMPLETION_STATUS, useExisting: DownPaymentService },
    // Task 4-8: the refunds of an application cancelled before funding.
    CompletionRefundService,
    { provide: COMPLETION_REFUNDS, useExisting: CompletionRefundService },
    // Task 4-8: the penalty rate each contract was made with (owner س۴).
    ContractTermsService,
    { provide: CONTRACT_TERMS, useExisting: ContractTermsService },
    // Task 4-8: the refunds paid out by bank.
    RefundPaymentService,
  ],
  // PAYMENT_PROVIDER: the borrower's repayment slips keep their evidence the same way (6-2).
  exports: [COMPLETION_STATUS, COMPLETION_REFUNDS, CONTRACT_TERMS, PAYMENT_PROVIDER],
})
export class ContractModule {}
