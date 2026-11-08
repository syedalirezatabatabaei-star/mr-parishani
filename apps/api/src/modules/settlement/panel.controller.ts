import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  centerSummaryRowSchema,
  heldItemSchema,
  panelStatementSchema,
  statementPdfLinkSchema,
  upcomingItemSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import { ZodResponse } from '../../common/zod-response';
import { SettlementPanelService } from './panel.service';

/**
 * The doctor's settlement panel (task 5-6): their statements with PDF, what is owed in the
 * coming months, and what is held; a center's sums. The service checks whose it is.
 */
@Controller('settlement/panel')
export class SettlementPanelController {
  constructor(private readonly panel: SettlementPanelService) {}

  @RequirePermission('settlement.read_own')
  @Get('statements')
  @ZodResponse(z.array(panelStatementSchema))
  statements(@CurrentAccess() access: EffectiveAccess) {
    return this.panel.statements(access);
  }

  @RequirePermission('settlement.read_own')
  @Get('statements/:id')
  @ZodResponse(panelStatementSchema)
  statement(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.panel.statement(access, id);
  }

  @RequirePermission('settlement.read_own')
  @Get('statements/:id/pdf')
  @ZodResponse(statementPdfLinkSchema)
  pdf(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.panel.pdf(access, id);
  }

  @RequirePermission('settlement.read_own')
  @Get('upcoming')
  @ZodResponse(z.array(upcomingItemSchema))
  upcoming(@CurrentAccess() access: EffectiveAccess) {
    return this.panel.upcoming(access);
  }

  @RequirePermission('settlement.read_own')
  @Get('held')
  @ZodResponse(z.array(heldItemSchema))
  held(@CurrentAccess() access: EffectiveAccess) {
    return this.panel.held(access);
  }

  @RequirePermission('settlement.read_center_summary')
  @Get('center-summary')
  @ZodResponse(z.array(centerSummaryRowSchema))
  centerSummary(@CurrentAccess() access: EffectiveAccess) {
    return this.panel.centerSummary(access);
  }
}
