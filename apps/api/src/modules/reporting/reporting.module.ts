import { Global, Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { ReportController } from './report.controller';
import { ReportRegistry } from './report-registry';
import { ReportService } from './report.service';
import { SearchInsightsService } from './search-insights.service';

/**
 * The reporting module's core (task 7-3; doc 17 §2, §4, §5): the definitions and the
 * service, which the worker runs too (ADR-016) to make queued exports and PDFs.
 */
@Global()
@Module({
  providers: [ReportRegistry, ReportService, DashboardService, SearchInsightsService],
  exports: [ReportService, ReportRegistry, DashboardService, SearchInsightsService],
})
export class ReportingCoreModule {}

/** The reporting module as the API serves it. */
@Module({
  imports: [ReportingCoreModule],
  controllers: [ReportController],
})
export class ReportingModule {}
