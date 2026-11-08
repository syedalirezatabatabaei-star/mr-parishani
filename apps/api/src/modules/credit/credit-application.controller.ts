import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  createCreditApplicationSchema,
  assignCreditApplicationSchema,
  creditApplicationViewSchema,
  creditLockedQuoteViewSchema,
  creditApplicationListQuerySchema,
  creditApplicationListSchema,
  creditAssignmentViewSchema,
  creditGroupViewSchema,
  creditQueueQuerySchema,
  createCreditGroupSchema,
  createShortfallApplicationSchema,
  proformaPlanOptionsSchema,
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
import { CreditApplicationService } from './credit-application.service';

const checkConditionSchema = z.strictObject({ note: z.string().trim().max(500).optional() });

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

/** A patient's (or borrower's) own credit applications (task 3-5; self-service, rule 13). */
@Controller('me')
export class PatientCreditController {
  constructor(private readonly applications: CreditApplicationService) {}

  @SelfService()
  @Get('proformas/:id/plans')
  @ZodResponse(proformaPlanOptionsSchema)
  plans(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.applications.planOptions(patientOnly(auth), id);
  }

  @SelfService()
  @Post('credit-applications')
  @ZodResponse(creditApplicationViewSchema)
  create(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(createCreditApplicationSchema))
    body: z.output<typeof createCreditApplicationSchema>,
  ) {
    return this.applications.create(actor, patientOnly(auth), body);
  }

  /** Over the cap: two borrowers, each on a share of one proforma (task 3-7, doc 10 §7). */
  @SelfService()
  @Post('credit-application-groups')
  @ZodResponse(z.array(creditApplicationViewSchema))
  createGroup(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(createCreditGroupSchema)) body: z.output<typeof createCreditGroupSchema>,
  ) {
    return this.applications.createGroup(actor, patientOnly(auth), body);
  }

  /** A large shortfall: a new case and loan for what the approval left (doc 10 §7). */
  @SelfService()
  @Post('credit-applications/:id/shortfall-application')
  @ZodResponse(creditApplicationViewSchema)
  shortfall(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(createShortfallApplicationSchema))
    body: z.output<typeof createShortfallApplicationSchema>,
  ) {
    return this.applications.createForShortfall(actor, patientOnly(auth), id, body);
  }

  @SelfService()
  @Get('credit-applications')
  @ZodResponse(z.array(creditApplicationViewSchema))
  mine(@CurrentAuth() auth: AuthContext) {
    return this.applications.listMine(patientOnly(auth));
  }

  @SelfService()
  @Get('credit-applications/:id')
  @ZodResponse(creditApplicationViewSchema)
  one(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.applications.getMine(patientOnly(auth), id);
  }

  /** A draft's figures from its own locked versions (M1 §8.7, option ب). */
  @SelfService()
  @Get('credit-applications/:id/locked-quote')
  @ZodResponse(creditLockedQuoteViewSchema)
  lockedQuote(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.applications.lockedQuoteMine(patientOnly(auth), id);
  }

  @SelfService()
  @Post('credit-applications/:id/submit')
  @ZodResponse(creditApplicationViewSchema)
  submit(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.applications.submit(actor, patientOnly(auth), id);
  }
}

/** The groups of applications that finance one treatment together (task 3-7, doc 10 §7). */
@Controller('credit/groups')
export class CreditGroupController {
  constructor(private readonly applications: CreditApplicationService) {}

  @RequirePermission('credit.read_applications')
  @Get()
  @ZodResponse(z.array(creditGroupViewSchema))
  list(@CurrentAccess() access: EffectiveAccess) {
    return this.applications.groups(access);
  }

  @RequirePermission('credit.read_applications')
  @Get(':id')
  @ZodResponse(creditGroupViewSchema)
  one(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.applications.group(access, id);
  }
}

/** Credit applications for the credit units (task 3-5). */
@Controller('credit/applications')
export class CreditApplicationController {
  constructor(private readonly applications: CreditApplicationService) {}

  /** Every application the caller's scope reaches, filtered and paged (task 3-8). */
  @RequirePermission('credit.read_applications')
  @Get()
  @ZodResponse(creditApplicationListSchema)
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(creditApplicationListQuerySchema))
    query: z.output<typeof creditApplicationListQuerySchema>,
  ) {
    return this.applications.list(access, query);
  }

  /** The caller's own work in a queue. Declared before `:id`, so the path is not an id. */
  @RequirePermission('credit.read_applications')
  @Get('queue')
  @ZodResponse(z.array(creditApplicationViewSchema))
  queue(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(creditQueueQuerySchema)) query: z.output<typeof creditQueueQuerySchema>,
  ) {
    return this.applications.myQueue(access, query.queueCode);
  }

  @RequirePermission('credit.read_applications')
  @Get(':id')
  @ZodResponse(creditApplicationViewSchema)
  one(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.applications.get(access, id);
  }

  @RequirePermission('credit.read_applications')
  @Get(':id/assignments')
  @ZodResponse(z.array(creditAssignmentViewSchema))
  assignments(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.applications.assignments(access, id);
  }

  @RequirePermission('credit.assign_manually')
  @Post(':id/assignments')
  @ZodResponse(z.array(creditAssignmentViewSchema))
  assign(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(assignCreditApplicationSchema))
    body: z.output<typeof assignCreditApplicationSchema>,
  ) {
    return this.applications.assignManually(actor, access, id, body);
  }

  @RequirePermission('credit.check_conditions')
  @Post(':id/conditions/:index/check')
  @ZodResponse(creditApplicationViewSchema)
  checkCondition(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', new ParseIntPipe()) index: number,
    @Body(new ZodBody(checkConditionSchema)) body: z.output<typeof checkConditionSchema>,
  ) {
    return this.applications.checkCondition(actor, access, id, index, body.note);
  }

  @RequirePermission('credit.complete_applications')
  @Post(':id/ready-for-review')
  @ZodResponse(creditApplicationViewSchema)
  ready(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.applications.markReadyForReview(actor, access, id);
  }
}
