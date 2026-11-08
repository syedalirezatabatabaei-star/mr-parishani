import { Global, Module } from '@nestjs/common';
import {
  NO_DELIVERY_STATUS,
  NOTIFICATIONS,
  SMS_DELIVERY_STATUS,
} from '../../common/notification/notifications.port';
import { requiredEnv } from '../../infra/env';
import { QueueTextSmsSender } from '../../infra/sms-queue';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { NotificationController } from './notification.controller';
import { NOTIFICATION_SMS_SENDER, NotificationService } from './notification.service';
import { INBOX } from '../../common/notification/inbox.port';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

/**
 * The notification module (task 6-4; doc 15 §7): SMS templates with their allowed fields,
 * consent to promotional SMS, the allowed hours and every SMS recorded with its delivery.
 * The API records; the worker queues what is due and reads the provider's reports.
 */
@Global()
@Module({
  // Owner 1405/08/10: the bell of every account.
  controllers: [NotificationController, CampaignController, InboxController],
  providers: [
    NotificationService,
    // Task 6-5: scheduled and bulk SMS.
    CampaignService,
    { provide: NOTIFICATIONS, useExisting: NotificationService },
    {
      provide: NOTIFICATION_SMS_SENDER,
      useFactory: () =>
        new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
    },
    // The API asks no provider; the worker app gives its own (Kavenegar's reports).
    { provide: SMS_DELIVERY_STATUS, useValue: NO_DELIVERY_STATUS },
    InboxService,
    { provide: INBOX, useExisting: InboxService },
  ],
  exports: [NOTIFICATIONS, INBOX],
})
export class NotificationModule {}
