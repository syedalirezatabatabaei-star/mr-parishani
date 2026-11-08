import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  applicationScoringSchema,
  consentGivenSchema,
  consentTextSchema,
  consentSentSchema,
  giveConsentSchema,
  guarantorInvitedSchema,
  inviteGuarantorSchema,
  myGuaranteeSchema,
  requestConsentSchema,
  scoreSheetInputSchema,
  scoreSheetViewSchema,
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
import { CreditScoringService } from './credit-scoring.service';

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

/**
 * The borrower's and guarantors' own part (task 3-5 part B): consent with a one-time
 * code, introducing a guarantor, and a guarantor's view of their own commitment only.
 */
@Controller('me')
export class PatientCreditScoringController {
  constructor(private readonly scoring: CreditScoringService) {}

  /** The consent text in force, to read before consenting (doc 03 §8-6; task 3-8). */
  @SelfService()
  @Get('credit/consent-text')
  @ZodResponse(consentTextSchema)
  consentText(@CurrentAuth() auth: AuthContext) {
    patientOnly(auth);
    return this.scoring.consentText();
  }

  @SelfService()
  @Post('credit-applications/:id/consent/request')
  @ZodResponse(consentSentSchema)
  requestConsent(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(requestConsentSchema)) body: z.output<typeof requestConsentSchema>,
  ) {
    return this.scoring.requestConsent(patientOnly(auth), id, body.role, { ip: actor.ip });
  }

  @SelfService()
  @Post('credit-applications/:id/consent')
  @ZodResponse(consentGivenSchema)
  giveConsent(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(giveConsentSchema)) body: z.output<typeof giveConsentSchema>,
  ) {
    return this.scoring.giveConsent(actor, patientOnly(auth), id, body.role, body.code, {
      ip: actor.ip,
    });
  }

  @SelfService()
  @Post('credit-applications/:id/guarantors')
  @ZodResponse(guarantorInvitedSchema)
  invite(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(inviteGuarantorSchema)) body: z.output<typeof inviteGuarantorSchema>,
  ) {
    return this.scoring.inviteAsApplicant(actor, patientOnly(auth), id, body.mobile);
  }

  @SelfService()
  @Get('guarantees')
  @ZodResponse(z.array(myGuaranteeSchema))
  guarantees(@CurrentAuth() auth: AuthContext) {
    return this.scoring.myGuarantees(patientOnly(auth));
  }

  @SelfService()
  @Get('guarantees/:id')
  @ZodResponse(myGuaranteeSchema)
  guarantee(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.scoring.myGuarantee(patientOnly(auth), id);
  }
}

/** Scoring for the credit units (task 3-5 part B). */
@Controller('credit/applications')
export class CreditScoringController {
  constructor(private readonly scoring: CreditScoringService) {}

  @RequirePermission('credit.score_applications')
  @Post(':id/score-sheets')
  @ZodResponse(scoreSheetViewSchema)
  score(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(scoreSheetInputSchema)) body: z.output<typeof scoreSheetInputSchema>,
  ) {
    return this.scoring.score(actor, access, id, body);
  }

  @RequirePermission('credit.read_applications')
  @Get(':id/scoring')
  @ZodResponse(applicationScoringSchema)
  view(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.scoring.scoring(access, id);
  }

  @RequirePermission('credit.complete_applications')
  @Post(':id/guarantors')
  @ZodResponse(guarantorInvitedSchema)
  invite(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(inviteGuarantorSchema)) body: z.output<typeof inviteGuarantorSchema>,
  ) {
    return this.scoring.inviteAsStaff(actor, access, id, body.mobile);
  }
}
