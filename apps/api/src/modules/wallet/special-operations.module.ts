import { Module } from '@nestjs/common';
import { CreditTransferController, MyCreditTransferController } from './credit-transfer.controller';
import { CreditTransferService } from './credit-transfer.service';
import {
  PurseDoctorCandidatesController,
  SpecialOperationsController,
} from './special-operations.controller';
import { SpecialOperationsService } from './special-operations.service';

/**
 * Special operations on a credit purse (doc 12 §7; task 4-8): the API's side only, through
 * phase 1's WALLET and REPAYMENT ports. Apart from WalletModule, which the worker also loads.
 * Credit transfer to an AuthorizedRecipient too (part 5), behind its flag.
 */
@Module({
  controllers: [
    SpecialOperationsController,
    PurseDoctorCandidatesController,
    CreditTransferController,
    MyCreditTransferController,
  ],
  providers: [SpecialOperationsService, CreditTransferService],
})
export class SpecialOperationsModule {}
