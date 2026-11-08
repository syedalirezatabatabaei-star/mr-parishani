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
  cancelServiceAuthorizationSchema,
  deliverServiceSchema,
  doctorPatientViewSchema,
  doctorPurseLinesViewSchema,
  issueServiceAuthorizationSchema,
  myServiceAuthorizationViewSchema,
  serviceAuthorizationQuerySchema,
  serviceAuthorizationViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  CurrentAuth,
  RequirePermission,
  SelfService,
  type AuthContext,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { ServiceAuthorizationService } from './service-authorization.service';

/** Service authorization and delivery (doc 12 §6; task 4-6). */
@Controller('service')
export class ServiceController {
  constructor(private readonly service: ServiceAuthorizationService) {}

  /** The doctor's funded patients: names and whether a service can be authorized (owner, پ۲). */
  @RequirePermission('service.authorize')
  @Get('patients')
  @ZodResponse(z.array(doctorPatientViewSchema))
  patients(@CurrentActor() actor: Actor, @CurrentAccess() access: EffectiveAccess) {
    return this.service.patients(actor, access);
  }

  /** One funded patient's proforma lines, to authorize from (task 4-7). */
  @RequirePermission('service.authorize')
  @Get('patients/:purseId/lines')
  @ZodResponse(doctorPurseLinesViewSchema)
  purseLines(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('purseId', new ParseUUIDPipe()) purseId: string,
  ) {
    return this.service.purseLines(actor, access, purseId);
  }

  @RequirePermission('service.authorize')
  @Post('authorizations')
  @ZodResponse(serviceAuthorizationViewSchema)
  issue(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(issueServiceAuthorizationSchema))
    body: z.output<typeof issueServiceAuthorizationSchema>,
  ) {
    return this.service.issue(actor, access, body);
  }

  @RequirePermission('service.read')
  @Get('authorizations')
  @ZodResponse(z.array(serviceAuthorizationViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(serviceAuthorizationQuerySchema))
    query: z.output<typeof serviceAuthorizationQuerySchema>,
  ) {
    return this.service.list(actor, access, query);
  }

  @RequirePermission('service.read')
  @Get('authorizations/:id')
  @ZodResponse(serviceAuthorizationViewSchema)
  get(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.get(access, id);
  }

  @RequirePermission('service.authorize')
  @Post('authorizations/:id/resend')
  @ZodResponse(serviceAuthorizationViewSchema)
  resend(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.resend(actor, access, id);
  }

  @RequirePermission('service.authorize')
  @Post('authorizations/:id/deliver')
  @ZodResponse(serviceAuthorizationViewSchema)
  deliver(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(deliverServiceSchema)) body: z.output<typeof deliverServiceSchema>,
  ) {
    return this.service.deliver(actor, access, id, body.code);
  }

  /** Finance only, with a reason, before it is final (owner, پ۳ and ت۲). */
  @RequirePermission('service.cancel')
  @Post('authorizations/:id/cancel')
  @ZodResponse(serviceAuthorizationViewSchema)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(cancelServiceAuthorizationSchema))
    body: z.output<typeof cancelServiceAuthorizationSchema>,
  ) {
    return this.service.cancel(actor, access, id, body.reason);
  }
}

/** The patient's or borrower's own authorizations (rule 13). */
@Controller('me/service')
export class MyServiceController {
  constructor(private readonly service: ServiceAuthorizationService) {}

  @SelfService()
  @Get('authorizations')
  @ZodResponse(z.array(myServiceAuthorizationViewSchema))
  mine(@CurrentAuth() auth: AuthContext) {
    if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    return this.service.mine(auth.accountId);
  }
}
