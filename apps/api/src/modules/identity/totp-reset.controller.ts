import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { accessIdSchema, requestTotpResetSchema } from '@sepehr/contracts';
import type { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import { RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { TotpResetService } from './totp-reset.service';

/** Two-person TOTP reset for staff who lost their authenticator (doc 04 §5). */
@Controller('identity/totp-resets')
export class TotpResetController {
  constructor(private readonly resets: TotpResetService) {}

  @RequirePermission('identity.request_totp_reset')
  @Post()
  @ZodResponse(accessIdSchema)
  async request(
    @CurrentActor() actor: Actor,
    @Body(new ZodBody(requestTotpResetSchema)) body: z.output<typeof requestTotpResetSchema>,
  ) {
    return { id: await this.resets.request(actor, body.targetAccountId, body.reason) };
  }

  @RequirePermission('identity.approve_totp_reset')
  @Post(':id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.resets.approve(actor, id);
  }

  @RequirePermission('identity.approve_totp_reset')
  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.resets.reject(actor, id);
  }
}
