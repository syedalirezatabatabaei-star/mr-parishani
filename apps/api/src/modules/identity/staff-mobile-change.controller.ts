import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  staffMobileChangeCreateSchema,
  staffMobileChangeDecideSchema,
  staffMobileChangeViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
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
import { StaffMobileChangeService } from './staff-mobile-change.service';

/** ADR-052: a financial signer's mobile, changed by two others (the CEO and the administrator). */
@Controller('identity/staff-mobile-changes')
export class StaffMobileChangeController {
  constructor(private readonly changes: StaffMobileChangeService) {}

  @RequireAnyPermission(
    'identity.request_financial_mobile_change',
    'identity.approve_financial_mobile_change',
  )
  @Get()
  @ZodResponse(z.array(staffMobileChangeViewSchema))
  list(@CurrentAccess() access: EffectiveAccess) {
    return this.changes.list(access);
  }

  @RequirePermission('identity.request_financial_mobile_change')
  @Post()
  @ZodResponse(staffMobileChangeViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(staffMobileChangeCreateSchema))
    body: z.output<typeof staffMobileChangeCreateSchema>,
  ) {
    return this.changes.request(actor, access, body);
  }

  @RequirePermission('identity.approve_financial_mobile_change')
  @Post(':id/decisions')
  @ZodResponse(staffMobileChangeViewSchema)
  decide(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(staffMobileChangeDecideSchema))
    body: z.output<typeof staffMobileChangeDecideSchema>,
  ) {
    return this.changes.decide(actor, access, id, body);
  }
}
