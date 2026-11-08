import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  closeCreditDecisionSchema,
  committeeVoteSchema,
  creditCaseStatusSchema,
  creditDecisionPageSchema,
  creditDecisionViewSchema,
  proposeCreditDecisionSchema,
} from '@sepehr/contracts';
import type { z } from 'zod';
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
import { CreditDecisionService } from './credit-decision.service';
import { CreditStatusService } from './credit-status.service';

/**
 * Credit decisions and the committee (task 3-6, doc 10 §6). The service checks who may
 * confirm what; the endpoints only admit those who may take part at all.
 */
@Controller('credit/applications/:id')
export class CreditDecisionController {
  constructor(private readonly decisions: CreditDecisionService) {}

  @RequirePermission('credit.read_applications')
  @Get('decision')
  @ZodResponse(creditDecisionPageSchema)
  page(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.decisions.page(access, id);
  }

  @RequirePermission('credit.propose_decision')
  @Post('to-decision')
  @ZodResponse(creditDecisionPageSchema)
  toDecision(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.decisions.toDecision(actor, access, id);
  }

  @RequireAnyPermission(
    'credit.propose_decision',
    'credit.decide_manager',
    'credit.decide_out_of_matrix',
  )
  @Post('decisions')
  @ZodResponse(creditDecisionViewSchema)
  propose(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(proposeCreditDecisionSchema))
    body: z.output<typeof proposeCreditDecisionSchema>,
  ) {
    return this.decisions.propose(actor, access, id, body);
  }

  @RequireAnyPermission(
    'credit.decide_second_check',
    'credit.decide_manager',
    'credit.decide_out_of_matrix',
  )
  @Post('decisions/:decisionId/confirm')
  @ZodResponse(creditDecisionViewSchema)
  confirm(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('decisionId', new ParseUUIDPipe()) decisionId: string,
  ) {
    return this.decisions.confirm(actor, access, id, decisionId);
  }

  @RequirePermission('credit.committee_vote')
  @Post('decisions/:decisionId/votes')
  @ZodResponse(creditDecisionViewSchema)
  vote(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('decisionId', new ParseUUIDPipe()) decisionId: string,
    @Body(new ZodBody(committeeVoteSchema)) body: z.output<typeof committeeVoteSchema>,
  ) {
    return this.decisions.vote(actor, access, id, decisionId, body);
  }

  /** The proposer withdraws it, or a confirmer refuses it; with a reason. */
  @RequireAnyPermission(
    'credit.propose_decision',
    'credit.decide_second_check',
    'credit.decide_manager',
    'credit.decide_out_of_matrix',
  )
  @Post('decisions/:decisionId/close')
  @ZodResponse(creditDecisionViewSchema)
  close(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('decisionId', new ParseUUIDPipe()) decisionId: string,
    @Body(new ZodBody(closeCreditDecisionSchema)) body: z.output<typeof closeCreditDecisionSchema>,
  ) {
    return this.decisions.closeProposal(actor, access, id, decisionId, body.reason);
  }
}

/** A case's credit for its advisor, doctor or center: a state, never a score (doc 10 §6). */
@Controller('credit/cases')
export class CreditCaseStatusController {
  constructor(private readonly status: CreditStatusService) {}

  @RequirePermission('credit.read_status')
  @Get(':caseId/status')
  @ZodResponse(creditCaseStatusSchema)
  ofCase(
    @CurrentAccess() access: EffectiveAccess,
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
  ) {
    return this.status.ofCase(access, caseId);
  }
}
