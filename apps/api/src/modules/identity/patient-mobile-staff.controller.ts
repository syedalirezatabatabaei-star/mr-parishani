import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  decidePatientMobileChangeSchema,
  otpRequestedSchema,
  patientMobileChangeCodeSchema,
  patientMobileChangeViewSchema,
  proposePatientMobileChangeSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import { RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { PatientMobileStaffService } from './patient-mobile-staff.service';

/** ف۱۲ ب۲ (owner 1405/07/26): a lost patient mobile replaced by staff, by two people. */
@Controller('identity/patient-mobile-changes')
export class PatientMobileStaffController {
  constructor(private readonly changes: PatientMobileStaffService) {}

  @RequirePermission('identity.change_patient_mobile')
  @Post('code')
  @ZodResponse(otpRequestedSchema)
  @HttpCode(HttpStatus.ACCEPTED)
  sendCode(
    @CurrentActor() actor: Actor,
    @Body(new ZodBody(patientMobileChangeCodeSchema))
    body: z.output<typeof patientMobileChangeCodeSchema>,
  ) {
    return this.changes.sendCode(actor, body);
  }

  @RequirePermission('identity.change_patient_mobile')
  @Post()
  @ZodResponse(patientMobileChangeViewSchema)
  propose(
    @CurrentActor() actor: Actor,
    @Body(new ZodBody(proposePatientMobileChangeSchema))
    body: z.output<typeof proposePatientMobileChangeSchema>,
  ) {
    return this.changes.propose(actor, body);
  }

  @RequirePermission('identity.change_patient_mobile')
  @Get()
  @ZodResponse(z.array(patientMobileChangeViewSchema))
  pending(@CurrentActor() actor: Actor) {
    return this.changes.pending(actor);
  }

  @RequirePermission('identity.change_patient_mobile')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(patientMobileChangeViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decidePatientMobileChangeSchema))
    body: z.output<typeof decidePatientMobileChangeSchema>,
  ) {
    return this.changes.approve(actor, id, body.reason);
  }

  @RequirePermission('identity.change_patient_mobile')
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(patientMobileChangeViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decidePatientMobileChangeSchema))
    body: z.output<typeof decidePatientMobileChangeSchema>,
  ) {
    return this.changes.reject(actor, id, body.reason);
  }
}
