import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ceoDashboardSchema,
  doctorDashboardSchema,
  unitDashboardSchema,
  exportReportSchema,
  reportExportLinkSchema,
  reportExportSchema,
  reportListItemSchema,
  reportResultSchema,
  reportTopicNamesSchema,
  runReportSchema,
  savedFilterInputSchema,
  savedFilterSchema,
  searchInsightsSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  RequireAnyPermission,
  RequirePermission,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { DashboardService } from './dashboard.service';
import { ReportService } from './report.service';
import { SearchInsightsService } from './search-insights.service';

const code = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const filterQuery = z.strictObject({ reportCode: code.optional() });

/**
 * Reports (task 7-3; doc 17 §2, §4, §5): each also needs its own permission, checked in the
 * service; exports are made of exactly what `run` returns and recorded; one's own only.
 */
@Controller('reporting')
export class ReportController {
  constructor(
    private readonly reports: ReportService,
    private readonly dashboards: DashboardService,
    private readonly insights: SearchInsightsService,
  ) {}

  // --- dashboards (task 7-5; doc 17 §3) ------------------------------------------------------

  @RequirePermission('reporting.dashboard_ceo')
  @Get('dashboards/ceo')
  @ZodResponse(ceoDashboardSchema)
  ceo(@CurrentAccess() access: EffectiveAccess) {
    return this.dashboards.ceo(access);
  }

  @RequireAnyPermission('ticket.work', 'ticket.assign', 'ticket.read_all')
  @Get('dashboards/units/:unit')
  @ZodResponse(unitDashboardSchema)
  unit(
    @CurrentAccess() access: EffectiveAccess,
    @Param('unit', new ZodBody(z.string().regex(/^[a-z][a-z_]{1,39}$/))) unit: string,
  ) {
    return this.dashboards.unit(access, unit);
  }

  @RequirePermission('settlement.read_own')
  @Get('dashboards/doctor')
  @ZodResponse(doctorDashboardSchema)
  doctor(@CurrentAccess() access: EffectiveAccess) {
    return this.dashboards.doctor(access);
  }

  // --- the search log (task 7-6; doc 17 §6) ---------------------------------------------------

  @RequirePermission('reporting.read_search')
  @Get('search-insights')
  @ZodResponse(searchInsightsSchema)
  async searchInsights(@CurrentAccess() access: EffectiveAccess) {
    return { markdown: await this.insights.markdown(access) };
  }

  @RequirePermission('reporting.run')
  @Get('ticket-topics')
  @ZodResponse(reportTopicNamesSchema)
  topicNames(@CurrentAccess() access: EffectiveAccess) {
    return this.reports.topicNames(access);
  }

  @RequirePermission('reporting.run')
  @Get('reports')
  @ZodResponse(z.array(reportListItemSchema))
  list(@CurrentAccess() access: EffectiveAccess) {
    return this.reports.list(access);
  }

  @RequirePermission('reporting.run')
  @Post('reports/:code/run')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(reportResultSchema)
  run(
    @CurrentAccess() access: EffectiveAccess,
    @Param('code', new ZodBody(code)) reportCode: string,
    @Body(new ZodBody(runReportSchema)) body: z.output<typeof runReportSchema>,
  ) {
    return this.reports.run(access, reportCode, body.params);
  }

  @RequirePermission('reporting.run')
  @Post('reports/:code/exports')
  @ZodResponse(reportExportSchema)
  export(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code', new ZodBody(code)) reportCode: string,
    @Body(new ZodBody(exportReportSchema)) body: z.output<typeof exportReportSchema>,
  ) {
    return this.reports.export(actor, access, reportCode, body);
  }

  @RequirePermission('reporting.run')
  @Get('exports')
  @ZodResponse(z.array(reportExportSchema))
  exports(@CurrentAccess() access: EffectiveAccess) {
    return this.reports.exports(access);
  }

  @RequirePermission('reporting.run')
  @Get('exports/:id/link')
  @ZodResponse(reportExportLinkSchema)
  link(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.reports.exportLink(access, id);
  }

  @RequirePermission('reporting.run')
  @Get('filters')
  @ZodResponse(z.array(savedFilterSchema))
  filters(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(filterQuery)) query: z.output<typeof filterQuery>,
  ) {
    return this.reports.filters(access, query.reportCode);
  }

  @RequirePermission('reporting.run')
  @Post('filters')
  @ZodResponse(savedFilterSchema)
  saveFilter(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(savedFilterInputSchema)) body: z.output<typeof savedFilterInputSchema>,
  ) {
    return this.reports.saveFilter(actor, access, body);
  }

  @RequirePermission('reporting.run')
  @Post('filters/:id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFilter(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.reports.deleteFilter(actor, access, id);
  }

  @RequirePermission('reporting.run')
  @Post('filters/:id/run')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(reportResultSchema)
  runFilter(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.reports.runFilter(access, id);
  }
}
