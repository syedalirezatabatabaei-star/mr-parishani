import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  cashServiceQuerySchema,
  cashServiceViewSchema,
  decideCashServiceSchema,
  disputeCashServiceSchema,
  recordCashServiceSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequireAnyPermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { CashServiceService } from './cash-service.service';

/**
 * Cash services (task 5-3): declared by the doctor's side (who authorizes services at the
 * workplace), or recorded by an advisor or accounting and confirmed by someone else. The
 * service checks the scope; these only let in who might.
 */
@Controller('settlement/cash-services')
export class CashServiceController {
  constructor(private readonly cash: CashServiceService) {}

  @RequireAnyPermission('settlement.record_cash_service', 'service.authorize')
  @Post()
  @ZodResponse(cashServiceViewSchema)
  record(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(recordCashServiceSchema)) body: z.output<typeof recordCashServiceSchema>,
  ) {
    return this.cash.record(actor, access, body);
  }

  @RequireAnyPermission(
    'settlement.record_cash_service',
    'settlement.confirm_cash_service',
    'service.authorize',
  )
  @Get()
  @ZodResponse(z.array(cashServiceViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(cashServiceQuerySchema)) query: z.output<typeof cashServiceQuerySchema>,
  ) {
    return this.cash.list(actor, access, query);
  }

  @RequireAnyPermission('settlement.confirm_cash_service', 'service.authorize')
  @Post(':id/decide')
  @ZodResponse(cashServiceViewSchema)
  decide(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCashServiceSchema)) body: z.output<typeof decideCashServiceSchema>,
  ) {
    return this.cash.decide(actor, access, id, body.outcome, body.reason);
  }

  @RequireAnyPermission('service.authorize')
  @Post(':id/dispute')
  @ZodResponse(cashServiceViewSchema)
  dispute(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(disputeCashServiceSchema)) body: z.output<typeof disputeCashServiceSchema>,
  ) {
    return this.cash.dispute(actor, access, id, body.reason);
  }
}
