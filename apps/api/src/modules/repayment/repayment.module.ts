import { Global, Module } from '@nestjs/common';
import { REPAYMENT } from '../../common/repayment/repayment.port';
import { RepaymentController } from './repayment.controller';
import { RepaymentService } from './repayment.service';

/**
 * Installments and payment allocation (task 1-3, doc 02 §4–5, ADR-019). Global: the
 * contract and collection modules use the REPAYMENT port.
 */
@Global()
@Module({
  controllers: [RepaymentController],
  // BORROWER_SMS_HOLD (task 6-6) is the collection module's (task 6-7).
  providers: [RepaymentService, { provide: REPAYMENT, useExisting: RepaymentService }],
  // The worker runs its nightly cycle (task 6-1).
  exports: [REPAYMENT, RepaymentService],
})
export class RepaymentModule {}
