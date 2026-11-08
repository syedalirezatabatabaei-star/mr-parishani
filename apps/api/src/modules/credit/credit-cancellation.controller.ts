import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  creditCancellationQuerySchema,
  creditCancellationViewSchema,
  decideCreditCancellationSchema,
  requestCreditCancellationSchema,
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
import { CreditCancellationService } from './credit-cancellation.service';

/** Cancelling an application before funding (task 4-8): asked by one, decided by another. */
@Controller('credit/cancellations')
export class CreditCancellationController {
  constructor(private readonly cancellations: CreditCancellationService) {}

  @RequirePermission('credit.request_cancellation')
  @Post()
  @ZodResponse(creditCancellationViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(requestCreditCancellationSchema))
    body: z.output<typeof requestCreditCancellationSchema>,
  ) {
    return this.cancellations.request(actor, access, body);
  }

  @RequireAnyPermission('credit.request_cancellation', 'credit.approve_cancellation')
  @Get()
  @ZodResponse(z.array(creditCancellationViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(creditCancellationQuerySchema))
    query: z.output<typeof creditCancellationQuerySchema>,
  ) {
    return this.cancellations.list(actor, access, query);
  }

  @RequirePermission('credit.approve_cancellation')
  @Post(':id/approve')
  @ZodResponse(creditCancellationViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCreditCancellationSchema))
    body: z.output<typeof decideCreditCancellationSchema>,
  ) {
    return this.cancellations.approve(actor, access, id, body.reason);
  }

  @RequirePermission('credit.approve_cancellation')
  @Post(':id/reject')
  @ZodResponse(creditCancellationViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCreditCancellationSchema))
    body: z.output<typeof decideCreditCancellationSchema>,
  ) {
    return this.cancellations.reject(actor, access, id, body.reason);
  }
}
