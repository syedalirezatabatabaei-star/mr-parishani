import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  fundingQuerySchema,
  fundingRequestViewSchema,
  myFundingViewSchema,
  rejectFundingSchema,
  requestFundingSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  CurrentAuth,
  RequireAnyPermission,
  RequirePermission,
  SelfService,
  type AuthContext,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { FundingService } from './funding.service';

/** Funding a purse (doc 12 §5; task 4-5): asked by case completion, approved by finance. */
@Controller('funding/requests')
export class FundingController {
  constructor(private readonly funding: FundingService) {}

  @RequirePermission('wallet.request_funding')
  @Post()
  @ZodResponse(fundingRequestViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(requestFundingSchema)) body: z.output<typeof requestFundingSchema>,
  ) {
    return this.funding.request(actor, access, body.creditApplicationId);
  }

  @RequireAnyPermission('wallet.request_funding', 'wallet.approve_funding')
  @Get()
  @ZodResponse(z.array(fundingRequestViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(fundingQuerySchema)) query: z.output<typeof fundingQuerySchema>,
  ) {
    return this.funding.list(access, actor.accountId, query);
  }

  @RequirePermission('wallet.approve_funding')
  @Post(':id/approve')
  @ZodResponse(fundingRequestViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.funding.approve(actor, access, id);
  }

  @RequirePermission('wallet.approve_funding')
  @Post(':id/reject')
  @ZodResponse(fundingRequestViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(rejectFundingSchema)) body: z.output<typeof rejectFundingSchema>,
  ) {
    return this.funding.reject(actor, access, id, body.reason);
  }
}

/** The patient's or borrower's funded purse and installments (rule 13: their own only). */
@Controller('me/funding')
export class MyFundingController {
  constructor(private readonly funding: FundingService) {}

  @SelfService()
  @Get(':applicationId')
  @ZodResponse(myFundingViewSchema)
  mine(
    @CurrentAuth() auth: AuthContext,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
  ) {
    if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    return this.funding.mine(auth.accountId, applicationId);
  }
}
