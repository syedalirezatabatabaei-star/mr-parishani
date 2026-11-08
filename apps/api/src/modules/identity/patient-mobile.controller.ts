import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  otpRequestedSchema,
  patientMobileChangedSchema,
  patientMobileChangeRequestSchema,
  patientMobileChangeVerifySchema,
} from '@sepehr/contracts';
import type { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAuth, SelfService, type AuthContext } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { PatientMobileService } from './patient-mobile.service';

/** ف۱۲ (owner 1405/07/26, option «ب»): a signed-in patient replaces their login mobile. */
@Controller('me/mobile')
export class PatientMobileController {
  constructor(private readonly mobiles: PatientMobileService) {}

  @SelfService()
  @Post('request')
  @ZodResponse(otpRequestedSchema)
  @HttpCode(HttpStatus.ACCEPTED)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(patientMobileChangeRequestSchema))
    body: z.output<typeof patientMobileChangeRequestSchema>,
  ) {
    return this.mobiles.request(actor, auth, body.mobile);
  }

  @SelfService()
  @Post('verify')
  @ZodResponse(patientMobileChangedSchema)
  @HttpCode(HttpStatus.OK)
  verify(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(patientMobileChangeVerifySchema))
    body: z.output<typeof patientMobileChangeVerifySchema>,
  ) {
    return this.mobiles.verify(actor, auth, body.mobile, body.code);
  }
}
