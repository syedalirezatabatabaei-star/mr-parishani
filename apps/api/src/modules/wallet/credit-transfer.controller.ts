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
  approveCreditTransferSchema,
  creditTransferCodesSchema,
  creditTransferQuerySchema,
  creditTransferViewSchema,
  decideCreditTransferSchema,
  myCreditTransferViewSchema,
  requestCreditTransferSchema,
  revokeMyCreditTransferSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  CurrentAuth,
  RequireAnyPermission,
  RequirePermission,
  SelfService,
  type AuthContext,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { CreditTransferService } from './credit-transfer.service';

/** Credit transfer to an AuthorizedRecipient (task 4-8; doc 12 §7): staff's side. */
@Controller('wallet/credit-transfers')
export class CreditTransferController {
  constructor(private readonly transfers: CreditTransferService) {}

  @RequirePermission('wallet.request_credit_transfer')
  @Post()
  @ZodResponse(creditTransferViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(requestCreditTransferSchema))
    body: z.output<typeof requestCreditTransferSchema>,
  ) {
    return this.transfers.request(actor, access, body, { ip: actor.ip });
  }

  @RequireAnyPermission('wallet.request_credit_transfer', 'wallet.approve_credit_transfer')
  @Get()
  @ZodResponse(z.array(creditTransferViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(creditTransferQuerySchema))
    query: z.output<typeof creditTransferQuerySchema>,
  ) {
    return this.transfers.list(actor, access, query);
  }

  @RequirePermission('wallet.request_credit_transfer')
  @Post(':id/resend')
  @ZodResponse(creditTransferViewSchema)
  resend(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.transfers.resend(actor, access, id, { ip: actor.ip });
  }

  @RequirePermission('wallet.request_credit_transfer')
  @Post(':id/codes')
  @ZodResponse(creditTransferViewSchema)
  codes(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(creditTransferCodesSchema)) body: z.output<typeof creditTransferCodesSchema>,
  ) {
    return this.transfers.enterCodes(actor, access, id, body, { ip: actor.ip });
  }

  @RequirePermission('wallet.approve_credit_transfer')
  @Post(':id/approve')
  @ZodResponse(creditTransferViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(approveCreditTransferSchema))
    body: z.output<typeof approveCreditTransferSchema>,
  ) {
    return this.transfers.approve(actor, access, id, body.reason, body.paperReceived);
  }

  @RequirePermission('wallet.approve_credit_transfer')
  @Post(':id/reject')
  @ZodResponse(creditTransferViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCreditTransferSchema))
    body: z.output<typeof decideCreditTransferSchema>,
  ) {
    return this.transfers.reject(actor, access, id, body.reason);
  }

  @RequirePermission('wallet.request_credit_transfer')
  @Post(':id/revoke')
  @ZodResponse(creditTransferViewSchema)
  requestRevoke(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCreditTransferSchema))
    body: z.output<typeof decideCreditTransferSchema>,
  ) {
    return this.transfers.requestRevoke(actor, access, id, body.reason);
  }

  @RequirePermission('wallet.approve_credit_transfer')
  @Post(':id/revoke/approve')
  @ZodResponse(creditTransferViewSchema)
  approveRevoke(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCreditTransferSchema))
    body: z.output<typeof decideCreditTransferSchema>,
  ) {
    return this.transfers.decideRevoke(actor, access, id, body.reason, false);
  }

  @RequirePermission('wallet.approve_credit_transfer')
  @Post(':id/revoke/reject')
  @ZodResponse(creditTransferViewSchema)
  rejectRevoke(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCreditTransferSchema))
    body: z.output<typeof decideCreditTransferSchema>,
  ) {
    return this.transfers.decideRevoke(actor, access, id, body.reason, true);
  }
}

/** The borrower's recipients of their purse, and revoking one at once (owner س۷). */
@Controller('me/credit-transfers')
export class MyCreditTransferController {
  constructor(private readonly transfers: CreditTransferService) {}

  @SelfService()
  @Get(':applicationId')
  @ZodResponse(z.array(myCreditTransferViewSchema))
  mine(
    @CurrentAuth() auth: AuthContext,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
  ) {
    if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    return this.transfers.mine(auth.accountId, applicationId);
  }

  @SelfService()
  @Post(':applicationId/:id/revoke')
  @ZodResponse(z.array(myCreditTransferViewSchema))
  revoke(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(revokeMyCreditTransferSchema))
    body: z.output<typeof revokeMyCreditTransferSchema>,
  ) {
    if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    return this.transfers.revokeMine(actor, auth.accountId, applicationId, id, body.reason);
  }
}
