import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { ReportingDatabaseModule } from './db/reporting.module';
import { FilesModule } from './infra/files.module';
import { ALERT_SINK, LogAlertSink, type AlertSink } from './infra/ops/alerts';
import { PartitionMaintenance } from './infra/ops/partition-maintenance';
import { QueueMonitor } from './infra/ops/queue-monitor';
import { OutboxModule } from './infra/outbox/outbox.module';
import {
  WORKER_RUNTIME_OPTIONS,
  WorkerRuntime,
  type WorkerRuntimeOptions,
} from './infra/outbox/worker-runtime';
import { ACCESS_PORT } from './common/auth/access.port';
import { ACCOUNT_DIRECTORY } from './common/auth/account-directory.port';
import { FINANCIAL_STEP_UP, NoSessionStepUp } from './common/auth/step-up.port';
import { ORG_TREE } from './common/auth/org-tree.port';
import { BOOKABLE_SLOTS } from './common/booking/bookable-slots.port';
import { REFERRAL_DIRECTORY } from './common/booking/referral-directory.port';
import { WORKPLACE_CALENDAR } from './common/booking/workplace-calendar.port';
import { TARIFF_BOOK } from './common/catalog/tariff-book.port';
import { WORKPLACE_DIRECTORY } from './common/catalog/workplace-directory.port';
import { requiredEnv } from './infra/env';
import { QueueTextSmsSender } from './infra/sms-queue';
import { AccessService } from './modules/access/access.service';
import { AccountMobileCheck } from './modules/access/account-mobile-check';
import { AuditModule } from './modules/audit/audit.module';
import {
  APPOINTMENT_SMS_SENDER,
  AppointmentNotifier,
} from './modules/booking/appointment-notifier';
import { AppointmentSweeper } from './modules/booking/appointment-sweeper';
import { AvailabilityService } from './modules/booking/availability.service';
import { AppointmentBusyTime, BUSY_TIME } from './modules/booking/busy-time';
import { CalendarService } from './modules/booking/calendar.service';
import { ReferralService } from './modules/booking/referral.service';
import { BulkImportWorker } from './modules/catalog/bulk-import-worker';
import { CATALOG_CRYPTO, catalogCryptoFromEnv } from './modules/catalog/catalog.crypto';
import { CenterService } from './modules/catalog/center.service';
import { DoctorService } from './modules/catalog/doctor.service';
import { MediaWorker } from './modules/catalog/media-worker';
import { SearchIndex, SearchIndexConsumer } from './modules/catalog/search-index';
import { TariffService } from './modules/catalog/tariff.service';
import { ffmpegTranscoderFromEnv, VIDEO_TRANSCODER } from './modules/catalog/video-transcoder';
import { WorkplaceDirectoryService } from './modules/catalog/workplace-directory.service';
import { IdentityAccountDirectory } from './modules/identity/account-directory';
import {
  FactorNoticeConsumer,
  FactorNotices,
  PersonMobileNoticeConsumer,
} from './modules/identity/factor-notices';
import { ConfigModule } from './modules/config/config.module';
import { HolidayCoverageCheck } from './modules/config/holiday-coverage';
import { ProviderContractCheck } from './modules/config/provider-contract-check';
import { CaseFunnelConsumer } from './modules/lead/case-funnel.consumer';
import { CaseService } from './modules/lead/case.service';
import { LeadCoreModule } from './modules/lead/lead.module';
import { PersonMobileApprovalService } from './modules/lead/person-mobile-approval.service';
import { LedgerModule } from './modules/ledger/ledger.module';
import { LedgerReconciliation } from './modules/ledger/reconciliation';
import { CreditApplicationSweeper } from './modules/credit/credit-application-sweeper';
import { CREDIT_SMS_SENDER, CreditNotifier } from './modules/credit/credit-notifier';
import { ProformaService } from './modules/proforma/proforma.service';
import { ContractPrinter } from './modules/contract/contract-printer';
import { DownPaymentReconciliation } from './modules/contract/down-payment-reconciliation';
import { CREDIT_CONTRACT_FACTS } from './common/credit/credit-contract-facts.port';
import { CreditContractFactsAdapter } from './modules/credit/credit-contract-facts.adapter';
import { FUNDING_SMS_SENDER, FundingNotifier } from './modules/wallet/funding-notifier';
import {
  INSTRUMENT_SMS_SENDER,
  InstrumentNotifier,
} from './modules/instrument/instrument-notifier';
import { PDF_RENDERER } from './common/pdf/pdf-renderer.port';
import { pdfRendererFromEnv } from './infra/pdf-renderer';
import { RepaymentModule } from './modules/repayment/repayment.module';
import { CollectionCoreModule } from './modules/collection/collection.module';
import { TicketCoreModule } from './modules/ticket/ticket.module';
import { ReportingCoreModule } from './modules/reporting/reporting.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PROFORMA_DIRECTORY } from './common/proforma/proforma-directory.port';
import { ProformaDirectoryService } from './modules/proforma/proforma-directory.service';
import { DoctorPatientsProjector } from './modules/service/doctor-patients.projector';
import { SERVICE_DELIVERIES } from './common/service/service-deliveries.port';
import { ServiceDeliveryDirectory } from './modules/service/service-delivery.directory';
import { SettlementConsumer } from './modules/settlement/settlement.consumer';
import { StatementPrinter } from './modules/settlement/statement-printer';
import {
  NO_DELIVERY_STATUS,
  NOTIFICATIONS,
  SMS_DELIVERY_STATUS,
  type SmsDeliveryStatus,
} from './common/notification/notifications.port';
import {
  NOTIFICATION_SMS_SENDER,
  NotificationService,
} from './modules/notification/notification.service';
import { SettlementRefundsDirectory } from './modules/settlement/settlement-refunds.directory';
import { SETTLEMENT_REFUNDS } from './common/settlement/settlement-refunds.port';
import { SettlementReconciliation } from './modules/settlement/settlement-reconciliation';
import { StatementService } from './modules/settlement/statement.service';
import { SettlementService } from './modules/settlement/settlement.service';
import {
  SERVICE_SMS_SENDER,
  ServiceAuthorizationService,
} from './modules/service/service-authorization.service';
import { SERVICE_CODES, serviceCodesFromEnv } from './modules/service/service-codes';
import { BOOKING_PATIENTS } from './common/booking/booking-patients.port';
import { AppointmentPatients } from './modules/booking/booking-patients';
import { CampaignService } from './modules/notification/campaign.service';
import { INBOX } from './common/notification/inbox.port';
import { InboxConsumer } from './modules/notification/inbox.consumer';
import { InboxService } from './modules/notification/inbox.service';

/** ADR-052: the worker's FINANCIAL_STEP_UP, for every module it holds; jobs sign nothing. */
@Global()
@Module({
  providers: [{ provide: FINANCIAL_STEP_UP, useClass: NoSessionStepUp }],
  exports: [FINANCIAL_STEP_UP],
})
class WorkerStepUpModule {}

/**
 * Owner 1405/08/10: the bell in the worker — INBOX for every module it holds (the content's
 * notices, the partnership's), and the consumer that turns domain events into notifications.
 */
@Global()
@Module({
  providers: [InboxService, { provide: INBOX, useExisting: InboxService }],
  exports: [INBOX],
})
class WorkerInboxModule {}

export interface WorkerModuleOptions extends WorkerRuntimeOptions {
  /** Where alerts go; the worker app passes one that also sends SMS. Default: log. */
  readonly alertSink?: AlertSink;
  /** The SMS provider's delivery reports (task 6-4); the worker app gives Kavenegar's. */
  readonly smsDeliveryStatus?: SmsDeliveryStatus;
}

/**
 * The API's modules as the worker runs them (ADR-016): the same business logic, as an
 * application context without HTTP. Holds the modules whose event consumers or services
 * background jobs need; each later module with consumers is added here.
 */
@Module({})
export class WorkerModule {
  static forRoot(options: WorkerModuleOptions = {}): DynamicModule {
    const { alertSink, smsDeliveryStatus, ...runtime } = options;
    return {
      module: WorkerModule,
      imports: [
        DatabaseModule,
        ReportingDatabaseModule,
        AuditModule,
        WorkerStepUpModule,
        WorkerInboxModule,
        ConfigModule,
        OutboxModule,
        FilesModule,
        LedgerModule,
        // The lead import processor (task 2-5b) and what its intake asks: repayment, on wallet.
        WalletModule,
        RepaymentModule,
        LeadCoreModule,
        // The overdue queue's nightly cycle and the borrower SMS hold (task 6-7).
        CollectionCoreModule,
        // Tickets: the sweep and the proforma dispute consumer (task 7-1).
        TicketCoreModule,
        // Reports: queued exports and PDFs (task 7-3).
        ReportingCoreModule,
      ],
      providers: [
        { provide: ALERT_SINK, useValue: alertSink ?? new LogAlertSink() },
        { provide: WORKER_RUNTIME_OPTIONS, useValue: runtime },
        PartitionMaintenance,
        QueueMonitor,
        LedgerReconciliation,
        HolidayCoverageCheck,
        ProviderContractCheck,
        // Booking (task 2-6): the appointment scheduler and SMS. The two directories they read
        // are provided here directly, without the catalog and identity modules' HTTP parts.
        AppointmentSweeper,
        AppointmentNotifier,
        { provide: WORKPLACE_DIRECTORY, useClass: WorkplaceDirectoryService },
        { provide: ACCOUNT_DIRECTORY, useClass: IdentityAccountDirectory },
        {
          provide: APPOINTMENT_SMS_SENDER,
          useFactory: () =>
            new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
        },
        // The public search index (task 2-7): its consumer and refresher, with the prices and
        // the free times they read, provided directly like booking's above.
        SearchIndex,
        SearchIndexConsumer,
        { provide: TARIFF_BOOK, useClass: TariffService },
        CalendarService,
        AvailabilityService,
        { provide: BUSY_TIME, useClass: AppointmentBusyTime },
        { provide: BOOKABLE_SLOTS, useExisting: AvailabilityService },
        // Profile media (task 2-8): scanning, variants and the public space.
        MediaWorker,
        { provide: VIDEO_TRANSCODER, useFactory: ffmpegTranscoderFromEnv },
        // The bulk import of centers and doctors (task 2-9): it creates and applies through
        // the catalog's services and booking's calendar, as the uploader (ACCESS_PORT).
        // Needs FIELD_ENCRYPTION_KEY and BLIND_INDEX_KEY, like the API.
        AccessService,
        { provide: ACCESS_PORT, useExisting: AccessService },
        { provide: ORG_TREE, useExisting: AccessService },
        { provide: CATALOG_CRYPTO, useFactory: catalogCryptoFromEnv },
        CenterService,
        DoctorService,
        { provide: WORKPLACE_CALENDAR, useExisting: CalendarService },
        BulkImportWorker,
        // The case funnel (owner 1405/07/23, question 8): appointments and proformas move their
        // case, through the lead module's CaseService.
        CaseService,
        CaseFunnelConsumer,
        // Proformas (task 3-4): expiring the overdue ones; the referral port it is built with.
        { provide: REFERRAL_DIRECTORY, useClass: ReferralService },
        ProformaService,
        // Credit applications (task 3-5): their deadlines and expiry, and the guarantor's
        // invitation SMS.
        CreditApplicationSweeper,
        CreditNotifier,
        {
          provide: CREDIT_SMS_SENDER,
          useFactory: () =>
            new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
        },
        // Deliveries (task 4-2): the shortage SMS, and what it reads of the application.
        InstrumentNotifier,
        CreditContractFactsAdapter,
        { provide: CREDIT_CONTRACT_FACTS, useExisting: CreditContractFactsAdapter },
        {
          provide: INSTRUMENT_SMS_SENDER,
          useFactory: () =>
            new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
        },
        // Funding (task 4-5): the patient's and the doctor's SMS once a purse is funded.
        FundingNotifier,
        {
          provide: FUNDING_SMS_SENDER,
          useFactory: () =>
            new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
        },
        // Contracts (task 4-1): printed to PDF with headless Chromium (ADR-033).
        ContractPrinter,
        { provide: PDF_RENDERER, useFactory: pdfRendererFromEnv },
        // Services (task 4-6): expiring authorizations and finalizing deliveries, and the
        // doctor's patient list kept from wallet.funded.
        ServiceAuthorizationService,
        DoctorPatientsProjector,
        // Down payments' nightly reconciliation (task 4-6b), read only.
        DownPaymentReconciliation,
        // Accounts that would silently miss an SMS (task 4-6, technical task ف۴).
        AccountMobileCheck,
        { provide: PROFORMA_DIRECTORY, useClass: ProformaDirectoryService },
        { provide: SERVICE_CODES, useFactory: serviceCodesFromEnv },
        {
          provide: SERVICE_SMS_SENDER,
          useFactory: () =>
            new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
        },
        // Settlement (task 5-1): each final service becomes the doctor's payable and its fee;
        // payables fall due daily; reconciled nightly. The final services, read only.
        ServiceDeliveryDirectory,
        { provide: SERVICE_DELIVERIES, useExisting: ServiceDeliveryDirectory },
        SettlementService,
        SettlementConsumer,
        // Task 5-6: a paid statement printed to its PDF.
        StatementPrinter,
        // Task 5-2b: the down payments' reconciliation counts returned services' refunds.
        SettlementRefundsDirectory,
        { provide: SETTLEMENT_REFUNDS, useExisting: SettlementRefundsDirectory },
        // Task 6-4: SMS due are queued; the provider's delivery reports read.
        NotificationService,
        { provide: NOTIFICATIONS, useExisting: NotificationService },
        {
          provide: NOTIFICATION_SMS_SENDER,
          useFactory: () =>
            new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
        },
        { provide: SMS_DELIVERY_STATUS, useValue: smsDeliveryStatus ?? NO_DELIVERY_STATUS },
        // Task 9-3 (R2): a login factor change told by SMS, after its commit.
        FactorNoticeConsumer,
        // Task 9-3 (م۵): a pending mobile's change told to the Person's proved mobiles.
        FactorNotices,
        PersonMobileNoticeConsumer,
        // Task 9-3 (م۵): pending mobiles refused at their deadline.
        PersonMobileApprovalService,
        // Task 6-5: bulk SMS sent gradually; its filters read booking's patients port.
        CampaignService,
        { provide: BOOKING_PATIENTS, useClass: AppointmentPatients },
        // Owner 1405/08/10: the bell's notifications from the domain events.
        InboxConsumer,
        SettlementReconciliation,
        // Task 5-4: the drafts of last month's statements, daily.
        StatementService,
        WorkerRuntime,
      ],
    };
  }
}
