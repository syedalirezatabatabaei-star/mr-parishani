import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  accountMobileRequestSchema,
  accountMobileVerifySchema,
  accountMobileViewSchema,
  otpRequestedSchema,
} from '@sepehr/contracts';
import type { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import {
  AllowWithoutMobile,
  CurrentAuth,
  SelfService,
  type AuthContext,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { AccountMobileService } from './account-mobile.service';

/**
 * A staff or center user's own mobile, verified by a code sent to it (task 4-6). Reachable
 * before the mobile is proved, when that is required (task 9-3, owner's question 3).
 */
@AllowWithoutMobile()
@Controller('auth/mobile')
export class AccountMobileController {
  constructor(private readonly mobiles: AccountMobileService) {}

  @SelfService()
  @Get()
  @ZodResponse(accountMobileViewSchema)
  view(@CurrentAuth() auth: AuthContext) {
    return this.mobiles.view(auth.accountId);
  }

  @SelfService()
  @Post('request')
  @ZodResponse(otpRequestedSchema)
  @HttpCode(HttpStatus.ACCEPTED)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(accountMobileRequestSchema))
    body: z.output<typeof accountMobileRequestSchema>,
  ) {
    return this.mobiles.request(actor, auth.accountId, body.mobile);
  }

  @SelfService()
  @Post('verify')
  @ZodResponse(accountMobileViewSchema)
  @HttpCode(HttpStatus.OK)
  verify(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(accountMobileVerifySchema)) body: z.output<typeof accountMobileVerifySchema>,
  ) {
    return this.mobiles.verify(actor, auth.accountId, body.mobile, body.code);
  }
}
