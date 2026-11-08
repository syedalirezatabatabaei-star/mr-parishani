import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  approveExecutionSchema,
  executionCandidateSchema,
  executionCandidatesQuerySchema,
  executionAlertSchema,
  executionBouncedSchema,
  executionClearedSchema,
  executionQuerySchema,
  executionViewSchema,
  proposeExecutionSchema,
  rejectExecutionSchema,
  releaseDueRowSchema,
  releaseRequestCreateSchema,
  releaseRequestDecideSchema,
  releaseRequestOutcomeSchema,
  releaseRequestViewSchema,
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
import { InstrumentExecutionService } from './execution.service';

/** Executing a cheque (proposed, approved by two others, cleared or bounced): task 6-8. */
@Controller('instrument-executions')
export class InstrumentExecutionController {
  constructor(private readonly executions: InstrumentExecutionService) {}

  /** Task 6-9: a case's held cheques and notes, for the agent to propose (last four only). */
  @RequirePermission('instrument.propose_execution')
  @Get('candidates')
  @ZodResponse(z.array(executionCandidateSchema))
  candidates(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(executionCandidatesQuerySchema))
    query: z.output<typeof executionCandidatesQuerySchema>,
  ) {
    return this.executions.candidates(access, query.caseId);
  }

  @RequirePermission('instrument.propose_execution')
  @Post()
  @ZodResponse(executionViewSchema)
  propose(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(proposeExecutionSchema)) body: z.output<typeof proposeExecutionSchema>,
  ) {
    return this.executions.propose(actor, access, body);
  }

  @RequireAnyPermission(
    'instrument.propose_execution',
    'instrument.approve_execution_collection',
    'instrument.approve_execution_finance',
    'instrument.record_outcome',
  )
  @Get()
  @ZodResponse(z.array(executionViewSchema))
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(executionQuerySchema)) query: z.output<typeof executionQuerySchema>,
  ) {
    return this.executions.list(access, query.status);
  }

  @RequireAnyPermission(
    'instrument.approve_execution_collection',
    'instrument.approve_execution_finance',
  )
  @Get('alerts')
  @ZodResponse(z.array(executionAlertSchema))
  alerts(@CurrentAccess() access: EffectiveAccess) {
    return this.executions.alerts(access);
  }

  @RequireAnyPermission(
    'instrument.approve_execution_collection',
    'instrument.approve_execution_finance',
  )
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(executionViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(approveExecutionSchema)) body: z.output<typeof approveExecutionSchema>,
  ) {
    return this.executions.approve(actor, access, id, body);
  }

  @RequireAnyPermission(
    'instrument.approve_execution_collection',
    'instrument.approve_execution_finance',
  )
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(executionViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(rejectExecutionSchema)) body: z.output<typeof rejectExecutionSchema>,
  ) {
    return this.executions.reject(actor, access, id, body.reason);
  }

  @RequirePermission('instrument.record_outcome')
  @Post(':id/cleared')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(executionViewSchema)
  cleared(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(executionClearedSchema)) body: z.output<typeof executionClearedSchema>,
  ) {
    return this.executions.cleared(actor, access, id, body);
  }

  @RequirePermission('instrument.record_outcome')
  @Post(':id/bounced')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(executionViewSchema)
  bounced(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(executionBouncedSchema)) body: z.output<typeof executionBouncedSchema>,
  ) {
    return this.executions.bounced(actor, access, id, body);
  }
}

/**
 * Accounting's live queue of instruments to release (task 6-8), and the release: asked by one,
 * approved or refused by another, each with their own SMS code (ADR-052).
 */
@Controller('instrument-releases')
export class InstrumentReleaseController {
  constructor(private readonly executions: InstrumentExecutionService) {}

  @RequireAnyPermission('instrument.approve_release', 'instrument.request_release')
  @Get('due')
  @ZodResponse(z.array(releaseDueRowSchema))
  due(@CurrentAccess() access: EffectiveAccess) {
    return this.executions.releasesDue(access);
  }

  @RequirePermission('instrument.request_release')
  @Post(':instrumentId/requests')
  @ZodResponse(releaseRequestViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('instrumentId', new ParseUUIDPipe()) instrumentId: string,
    @Body(new ZodBody(releaseRequestCreateSchema))
    body: z.output<typeof releaseRequestCreateSchema>,
  ) {
    return this.executions.requestRelease(actor, access, instrumentId, body.reason);
  }

  @RequirePermission('instrument.approve_release')
  @Post('requests/:requestId/decision')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(releaseRequestOutcomeSchema)
  decide(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Body(new ZodBody(releaseRequestDecideSchema))
    body: z.output<typeof releaseRequestDecideSchema>,
  ) {
    return this.executions.decideRelease(actor, access, requestId, body);
  }

  @RequirePermission('instrument.request_release')
  @Post('requests/:requestId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(releaseRequestOutcomeSchema)
  withdraw(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ) {
    return this.executions.withdrawRelease(actor, access, requestId);
  }
}
