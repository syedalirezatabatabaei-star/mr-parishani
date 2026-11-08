import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  costSplitStateSchema,
  formationDepositStateSchema,
  formationDepositViewSchema,
  recordFormationDepositRefundSchema,
  recordCostSplitReviewSchema,
  recordFormationDepositSchema,
} from '@sepehr/contracts';
import type { z } from 'zod';
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
import { CostSplitReviewService } from './cost-split-review.service';
import { FormationDepositService } from './formation-deposit.service';

/**
 * The formation deposit's details (owner 1405/07/29, answer f): recorded by case completion,
 * with its refund before the introduction letter. No ledger row in the pilot.
 */
@Controller('credit')
export class FormationDepositController {
  constructor(private readonly deposits: FormationDepositService) {}

  @RequireAnyPermission('credit.record_formation_deposit', 'credit.read_applications')
  @Get('applications/:id/formation-deposit')
  @ZodResponse(formationDepositStateSchema)
  state(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.deposits.state(access, id);
  }

  @RequirePermission('credit.record_formation_deposit')
  @Post('applications/:id/formation-deposit')
  @ZodResponse(formationDepositViewSchema)
  record(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(recordFormationDepositSchema))
    body: z.output<typeof recordFormationDepositSchema>,
  ) {
    return this.deposits.record(actor, access, id, body);
  }

  @RequirePermission('credit.record_formation_deposit')
  @Post('applications/:id/formation-deposit/refund')
  @ZodResponse(formationDepositViewSchema)
  refund(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(recordFormationDepositRefundSchema))
    body: z.output<typeof recordFormationDepositRefundSchema>,
  ) {
    return this.deposits.recordRefund(actor, access, id, body);
  }
}

/** ADR-050: a wage-only application's split of wage and materials, checked before its decision. */
@Controller('credit')
export class CostSplitReviewController {
  constructor(private readonly reviews: CostSplitReviewService) {}

  @RequireAnyPermission('credit.review_cost_split', 'credit.read_applications')
  @Get('applications/:id/cost-split')
  @ZodResponse(costSplitStateSchema)
  state(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.reviews.state(access, id);
  }

  @RequirePermission('credit.review_cost_split')
  @Post('applications/:id/cost-split-review')
  @ZodResponse(costSplitStateSchema)
  record(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(recordCostSplitReviewSchema))
    body: z.output<typeof recordCostSplitReviewSchema>,
  ) {
    return this.reviews.record(actor, access, id, body);
  }
}
