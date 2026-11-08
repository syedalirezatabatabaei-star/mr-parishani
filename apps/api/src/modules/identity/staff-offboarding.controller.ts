import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { requestStaffOffboardingSchema, staffOffboardingViewSchema } from '@sepehr/contracts';
import { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { StaffOffboardingService } from './staff-offboarding.service';

/** Two-person offboarding of a staff or center account (owner 1405/07/23, plan 4). */
@Controller('identity/staff-offboardings')
export class StaffOffboardingController {
  constructor(private readonly offboardings: StaffOffboardingService) {}

  @RequirePermission('identity.request_staff_offboarding')
  @Post()
  @ZodResponse(staffOffboardingViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @Body(new ZodBody(requestStaffOffboardingSchema))
    body: z.output<typeof requestStaffOffboardingSchema>,
  ) {
    return this.offboardings.request(actor, body.targetAccountId, body.reason);
  }

  @RequireAnyPermission('identity.request_staff_offboarding', 'identity.approve_staff_offboarding')
  @Get()
  @ZodResponse(z.array(staffOffboardingViewSchema))
  pending(@CurrentActor() actor: Actor) {
    return this.offboardings.pending(actor);
  }

  @RequirePermission('identity.approve_staff_offboarding')
  @Post(':id/approve')
  @ZodResponse(staffOffboardingViewSchema)
  approve(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.offboardings.approve(actor, id);
  }

  @RequirePermission('identity.approve_staff_offboarding')
  @Post(':id/reject')
  @ZodResponse(staffOffboardingViewSchema)
  reject(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.offboardings.reject(actor, id);
  }
}
