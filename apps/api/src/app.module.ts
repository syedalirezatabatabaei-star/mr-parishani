import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RouteAccessAudit } from './common/auth/route-access-audit';
import { DatabaseModule } from './db/database.module';
import { ReportingDatabaseModule } from './db/reporting.module';
import { FilesModule } from './infra/files.module';
import { HealthModule } from './infra/health.controller';
import { OutboxModule } from './infra/outbox/outbox.module';
import { RedisModule } from './infra/redis.module';
import { AccessModule } from './modules/access/access.module';
import { AuditModule } from './modules/audit/audit.module';
import { BookingModule } from './modules/booking/booking.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CollectionModule } from './modules/collection/collection.module';
import { TicketModule } from './modules/ticket/ticket.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { ConfigModule } from './modules/config/config.module';
import { ContentModule } from './modules/config/content.module';
import { HolidaySuggestionModule } from './modules/config/holiday-suggestion.module';
import { ContractModule } from './modules/contract/contract.module';
import { CreditModule } from './modules/credit/credit.module';
import { InstrumentModule } from './modules/instrument/instrument.module';
import { IdentityModule } from './modules/identity/identity.module';
import { LeadModule } from './modules/lead/lead.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { ProformaModule } from './modules/proforma/proforma.module';
import { RepaymentModule } from './modules/repayment/repayment.module';
import { ServiceModule } from './modules/service/service.module';
import { FundingModule } from './modules/wallet/funding.module';
import { SpecialOperationsModule } from './modules/wallet/special-operations.module';
import { SettlementModule } from './modules/settlement/settlement.module';
import { NotificationModule } from './modules/notification/notification.module';
import { ReceiptUploadModule } from './modules/repayment/receipt-upload.module';
import { WalletModule } from './modules/wallet/wallet.module';

/**
 * Root module. Feature modules live in src/modules/<name> and never import each other
 * (lint rule sepehr/no-cross-module-import); they share interfaces and tokens from
 * @sepehr/contracts and src/common, and communicate through domain events.
 *
 * RouteAccessAudit refuses to start the API if any endpoint lacks an access marker.
 */
@Module({
  imports: [
    DatabaseModule,
    ReportingDatabaseModule,
    RedisModule,
    FilesModule,
    DiscoveryModule,
    OutboxModule,
    HealthModule,
    AuditModule,
    ConfigModule,
    // Owner 1405/08/10: the portal's content, the API's only.
    ContentModule,
    HolidaySuggestionModule,
    AccessModule,
    IdentityModule,
    LedgerModule,
    WalletModule,
    RepaymentModule,
    CatalogModule,
    BookingModule,
    LeadModule,
    CreditModule,
    ContractModule,
    FundingModule,
    SpecialOperationsModule,
    SettlementModule,
    NotificationModule,
    ReceiptUploadModule,
    CollectionModule,
    TicketModule,
    ReportingModule,
    ServiceModule,
    InstrumentModule,
    ProformaModule,
  ],
  providers: [RouteAccessAudit],
})
export class AppModule {}
