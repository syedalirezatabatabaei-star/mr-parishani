import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  decideVisitTariffSchema,
  proposeVisitTariffSchema,
  visitTariffProposalListQuerySchema,
  visitTariffProposalListSchema,
  visitTariffProposalViewSchema,
} from '@sepehr/contracts';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { VisitTariffProposalService } from './visit-tariff-proposal.service';

/**
 * A doctor's visit price from the internal panel, by two people (owner 1405/07/29, answer i).
 * The guard checks the permission; the service checks it again with the workplace's city.
 */
@Controller('catalog/visit-tariff-proposals')
export class VisitTariffProposalController {
  constructor(private readonly proposals: VisitTariffProposalService) {}

  @RequirePermission('catalog.manage_visit_tariffs')
  @Post()
  @ZodResponse(visitTariffProposalViewSchema)
  propose(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(proposeVisitTariffSchema)) body: z.output<typeof proposeVisitTariffSchema>,
  ) {
    return this.proposals.propose(actor, access, body);
  }

  @RequirePermission('catalog.manage_visit_tariffs')
  @Get()
  @ZodResponse(visitTariffProposalListSchema)
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(visitTariffProposalListQuerySchema))
    query: z.output<typeof visitTariffProposalListQuerySchema>,
  ) {
    return this.proposals.list(actor, access, query);
  }

  @RequirePermission('catalog.manage_visit_tariffs')
  @Post(':id/approve')
  @ZodResponse(visitTariffProposalViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideVisitTariffSchema)) body: z.output<typeof decideVisitTariffSchema>,
  ) {
    return this.proposals.approve(actor, access, id, body.reason);
  }

  @RequirePermission('catalog.manage_visit_tariffs')
  @Post(':id/reject')
  @ZodResponse(visitTariffProposalViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideVisitTariffSchema)) body: z.output<typeof decideVisitTariffSchema>,
  ) {
    return this.proposals.reject(actor, access, id, body.reason);
  }
}
