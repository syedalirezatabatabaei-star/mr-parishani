import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  disputeQuerySchema,
  disputeViewSchema,
  openDisputeSchema,
  resolveDisputeSchema,
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
import { DisputeService } from './dispute.service';

/** Financial disputes on settlement items (task 5-2): opened by one, decided by another. */
@Controller('settlement/disputes')
export class DisputeController {
  constructor(private readonly disputes: DisputeService) {}

  @RequirePermission('settlement.open_dispute')
  @Post()
  @ZodResponse(disputeViewSchema)
  open(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(openDisputeSchema)) body: z.output<typeof openDisputeSchema>,
  ) {
    return this.disputes.open(actor, access, body);
  }

  @RequireAnyPermission('settlement.open_dispute', 'settlement.resolve_dispute')
  @Get()
  @ZodResponse(z.array(disputeViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(disputeQuerySchema)) query: z.output<typeof disputeQuerySchema>,
  ) {
    return this.disputes.list(actor, access, query);
  }

  @RequirePermission('settlement.resolve_dispute')
  @Post(':id/resolve')
  @ZodResponse(disputeViewSchema)
  resolve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(resolveDisputeSchema)) body: z.output<typeof resolveDisputeSchema>,
  ) {
    return this.disputes.resolve(actor, access, id, body);
  }

  /** An accepted payable dispute posted: the service taken back (task 5-2b; ADR-038). */
  @RequirePermission('settlement.resolve_dispute')
  @Post(':id/post')
  @ZodResponse(disputeViewSchema)
  post(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.disputes.post(actor, access, id);
  }
}
