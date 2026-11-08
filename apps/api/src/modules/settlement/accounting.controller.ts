import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  heldReportRowSchema,
  negativeReportRowSchema,
  odooExportRequestSchema,
  odooExportSchema,
  odooMappingSchema,
  setOdooMappingSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { AccountingService } from './accounting.service';

/** Accounting's reports, the Odoo account mapping and the Odoo export (task 5-7). */
@Controller('settlement')
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @RequirePermission('settlement.read_reports')
  @Get('reports/held')
  @ZodResponse(z.array(heldReportRowSchema))
  held(@CurrentAccess() access: EffectiveAccess) {
    return this.accounting.held(access);
  }

  @RequirePermission('settlement.read_reports')
  @Get('reports/negative')
  @ZodResponse(z.array(negativeReportRowSchema))
  negative(@CurrentAccess() access: EffectiveAccess) {
    return this.accounting.negative(access);
  }

  @RequirePermission('settlement.manage_odoo_mapping')
  @Get('odoo/mappings')
  @ZodResponse(z.array(odooMappingSchema))
  mappings(@CurrentAccess() access: EffectiveAccess) {
    return this.accounting.mappings(access);
  }

  @RequirePermission('settlement.manage_odoo_mapping')
  @Post('odoo/mappings')
  @ZodResponse(z.array(odooMappingSchema))
  setMapping(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(setOdooMappingSchema)) body: z.output<typeof setOdooMappingSchema>,
  ) {
    return this.accounting.setMapping(actor, access, body);
  }

  @RequirePermission('settlement.manage_odoo_mapping')
  @Get('odoo/exports')
  @ZodResponse(z.array(odooExportSchema))
  exports(@CurrentAccess() access: EffectiveAccess) {
    return this.accounting.exports(access);
  }

  @RequirePermission('settlement.manage_odoo_mapping')
  @Post('odoo/exports')
  @ZodResponse(odooExportSchema)
  export(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(odooExportRequestSchema)) body: z.output<typeof odooExportRequestSchema>,
  ) {
    return this.accounting.export(actor, access, body.year, body.month);
  }
}
