import { Module } from '@nestjs/common';
import { FundingController, MyFundingController } from './funding.controller';
import { FundingService } from './funding.service';

/**
 * Funding a purse (task 4-5, doc 12 §5): the API's side only. It reads completion and the
 * application through the contract and credit modules' ports (COMPLETION_STATUS,
 * CREDIT_FUNDING_FACTS), and writes through phase 1's WALLET and REPAYMENT ports. Apart
 * from WalletModule, which the worker also loads without those ports.
 */
@Module({
  controllers: [FundingController, MyFundingController],
  providers: [FundingService],
})
export class FundingModule {}
