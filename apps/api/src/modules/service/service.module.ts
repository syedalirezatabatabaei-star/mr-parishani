import { Global, Module } from '@nestjs/common';
import { SERVICE_CONTROL } from '../../common/service/service-control.port';
import { SERVICE_DELIVERIES } from '../../common/service/service-deliveries.port';
import { SERVICE_REVERSALS } from '../../common/service/service-reversals.port';
import { ServiceDeliveryDirectory } from './service-delivery.directory';
import { requiredEnv } from '../../infra/env';
import { QueueTextSmsSender } from '../../infra/sms-queue';
import { SERVICE_SMS_SENDER, ServiceAuthorizationService } from './service-authorization.service';
import { SERVICE_CODES, serviceCodesFromEnv } from './service-codes';
import { MyServiceController, ServiceController } from './service.controller';
import { ServiceTicketLink } from './ticket-link';

/**
 * Service authorization and delivery (doc 12 §6; task 4-6 [financial]). Moves the purse only
 * through phase 1's WALLET port (reserve, cancel the reservation, register, reverse), and
 * reads the application, its proforma and workplace, and the borrower's mobile through the
 * credit, proforma, catalog and lead modules' ports. The worker runs its expiry and
 * finalization, and keeps the doctor's patient list from `wallet.funded`.
 */
@Global()
@Module({
  controllers: [ServiceController, MyServiceController],
  providers: [
    ServiceAuthorizationService,
    // For the wallet's special operations (task 4-8): a doctor change cancels open authorizations.
    { provide: SERVICE_CONTROL, useExisting: ServiceAuthorizationService },
    // Task 5-2b: settlement takes back a final service after an accepted dispute.
    { provide: SERVICE_REVERSALS, useExisting: ServiceAuthorizationService },
    // Task 5-1: the final services, read only, for settlement.
    ServiceDeliveryDirectory,
    { provide: SERVICE_DELIVERIES, useExisting: ServiceDeliveryDirectory },
    { provide: SERVICE_CODES, useFactory: serviceCodesFromEnv },
    // A ticket's link to a service authorization (task 7-1), read only.
    ServiceTicketLink,
    {
      provide: SERVICE_SMS_SENDER,
      useFactory: () =>
        new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
    },
  ],
  exports: [SERVICE_CONTROL, SERVICE_DELIVERIES, SERVICE_REVERSALS],
})
export class ServiceModule {}
