import { Body, Controller, Post } from '@nestjs/common';
import { stepUpChallengeViewSchema, stepUpOperationSchema } from '@sepehr/contracts';
import type { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import { SelfService } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { SmsOtpStepUp } from './step-up.service';

/**
 * ADR-052: a one-time code for one financial operation, to the caller's own verified mobile.
 * The financial request then carries it in `X-Step-Up`; the service checks and consumes it.
 */
@Controller('identity/step-up')
export class StepUpController {
  constructor(private readonly stepUp: SmsOtpStepUp) {}

  @SelfService()
  @Post('challenges')
  @ZodResponse(stepUpChallengeViewSchema)
  challenge(
    @CurrentActor() actor: Actor,
    @Body(new ZodBody(stepUpOperationSchema)) body: z.output<typeof stepUpOperationSchema>,
  ) {
    return this.stepUp.challenge(actor, body);
  }
}
