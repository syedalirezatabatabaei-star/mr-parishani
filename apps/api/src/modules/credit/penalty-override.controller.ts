import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  decidePenaltyOverrideSchema,
  penaltyOverrideViewSchema,
  requestPenaltyOverrideSchema,
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
import { PenaltyOverrideService } from './penalty-override.service';

/**
 * A case's own cancellation-penalty rate (task 4-8, owner پ۱۳): asked, then approved by another.
 * ADR-044 (owner 1405/07/27): asked by accounting, approved by the general manager.
 */
@Controller('credit')
export class PenaltyOverrideController {
  constructor(private readonly overrides: PenaltyOverrideService) {}

  @RequirePermission('credit.request_penalty_override')
  @Post('applications/:id/penalty-overrides')
  @ZodResponse(penaltyOverrideViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(requestPenaltyOverrideSchema))
    body: z.output<typeof requestPenaltyOverrideSchema>,
  ) {
    return this.overrides.request(actor, access, id, body);
  }

  @RequireAnyPermission('credit.request_penalty_override', 'credit.approve_penalty_override')
  @Get('applications/:id/penalty-overrides')
  @ZodResponse(z.array(penaltyOverrideViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.overrides.list(actor, access, id);
  }

  /** ADR-044: the requests waiting for a second person, for who asks or decides. */
  @RequireAnyPermission('credit.request_penalty_override', 'credit.approve_penalty_override')
  @Get('penalty-overrides')
  @ZodResponse(z.array(penaltyOverrideViewSchema))
  pending(@CurrentActor() actor: Actor, @CurrentAccess() access: EffectiveAccess) {
    return this.overrides.pending(actor, access);
  }

  @RequirePermission('credit.approve_penalty_override')
  @Post('penalty-overrides/:id/approve')
  @ZodResponse(penaltyOverrideViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decidePenaltyOverrideSchema))
    body: z.output<typeof decidePenaltyOverrideSchema>,
  ) {
    return this.overrides.decide(actor, access, id, true, body.reason);
  }

  @RequirePermission('credit.approve_penalty_override')
  @Post('penalty-overrides/:id/reject')
  @ZodResponse(penaltyOverrideViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decidePenaltyOverrideSchema))
    body: z.output<typeof decidePenaltyOverrideSchema>,
  ) {
    return this.overrides.decide(actor, access, id, false, body.reason);
  }
}
