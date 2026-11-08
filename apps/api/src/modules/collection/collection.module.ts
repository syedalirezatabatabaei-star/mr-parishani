import { Global, Module } from '@nestjs/common';
import { COLLECTION_ESCALATION } from '../../common/collection/collection-escalation.port';
import { BORROWER_SMS_HOLD } from '../../common/repayment/borrower-sms-hold.port';
import { CollectionController } from './collection.controller';
import { CollectionService } from './collection.service';

/**
 * The collection module's core (task 6-7; doc 15 §5): the queue and its nightly cycle, which
 * the worker runs too (ADR-016), and BORROWER_SMS_HOLD, through which repayment's reminders
 * (task 6-6) learn that a borrower is deceased or disabled. Global for that port.
 */
@Global()
@Module({
  providers: [
    CollectionService,
    { provide: BORROWER_SMS_HOLD, useExisting: CollectionService },
    // Task 6-8: a bounced cheque opens stage 4.
    { provide: COLLECTION_ESCALATION, useExisting: CollectionService },
  ],
  exports: [CollectionService, BORROWER_SMS_HOLD, COLLECTION_ESCALATION],
})
export class CollectionCoreModule {}

/** The collection module as the API serves it: the unit's endpoints on top of the core. */
@Module({
  imports: [CollectionCoreModule],
  controllers: [CollectionController],
})
export class CollectionModule {}
