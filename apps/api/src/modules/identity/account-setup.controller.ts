import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  setupPasswordSchema,
  setupTokenCheckSchema,
  setupTokenViewSchema,
} from '@sepehr/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../../common/auth/auth.decorators';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { AccountSetupService } from './account-setup.service';

/**
 * A center user's one-time link (owner 1405/08/10): public, the token in the body (never in
 * an address a log keeps). Checking it shows whose account it is; setting the password spends
 * it.
 */
@Controller('auth/setup')
export class AccountSetupController {
  constructor(private readonly setup: AccountSetupService) {}

  @Public()
  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(setupTokenViewSchema)
  check(
    @Body(new ZodBody(setupTokenCheckSchema)) body: z.output<typeof setupTokenCheckSchema>,
    @Req() req: Request,
  ) {
    return this.setup.check(body.token, req.ip ?? null);
  }

  @Public()
  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(z.object({ username: z.string() }))
  password(
    @Body(new ZodBody(setupPasswordSchema)) body: z.output<typeof setupPasswordSchema>,
    @Req() req: Request,
  ) {
    return this.setup.setPassword(body, req.ip ?? null);
  }
}
