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
  contractAcceptanceRequestSchema,
  contractAcceptanceSentSchema,
  contractAcceptSchema,
  contractLinkSchema,
  contractViewSchema,
  generateContractSchema,
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
import { ContractService } from './contract.service';

const byApplicationSchema = z.object({ creditApplicationId: z.uuid() });

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

/** Loan contracts for staff (task 4-1, doc 12 §2). */
@Controller('contracts')
export class ContractController {
  constructor(private readonly contracts: ContractService) {}

  @RequirePermission('contract.generate')
  @Post()
  @ZodResponse(contractViewSchema)
  generate(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(generateContractSchema)) body: z.output<typeof generateContractSchema>,
  ) {
    return this.contracts.generate(actor, access, body.creditApplicationId);
  }

  @RequirePermission('contract.read')
  @Get()
  @ZodResponse(z.array(contractViewSchema))
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(byApplicationSchema)) query: z.output<typeof byApplicationSchema>,
  ) {
    return this.contracts.forApplication(access, query.creditApplicationId);
  }

  @RequirePermission('contract.read')
  @Get(':id')
  @ZodResponse(contractViewSchema)
  one(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.contracts.get(access, id);
  }

  @RequirePermission('contract.read')
  @Get(':id/link')
  @ZodResponse(contractLinkSchema)
  link(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.contracts.staffLink(actor, access, id);
  }
}

/** A party's own contracts: the borrower and each guarantor (task 4-1; rule 13). */
@Controller('me/contracts')
export class PartyContractController {
  constructor(private readonly contracts: ContractService) {}

  @SelfService()
  @Get()
  @ZodResponse(z.array(contractViewSchema))
  mine(@CurrentAuth() auth: AuthContext) {
    return this.contracts.mine(patientOnly(auth));
  }

  @SelfService()
  @Get(':id')
  @ZodResponse(contractViewSchema)
  one(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.contracts.getMine(patientOnly(auth), id);
  }

  @SelfService()
  @Get(':id/link')
  @ZodResponse(contractLinkSchema)
  link(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.contracts.ownLink(actor, patientOnly(auth), id);
  }

  @SelfService()
  @Post(':id/acceptance/request')
  @ZodResponse(contractAcceptanceSentSchema)
  requestAcceptance(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(contractAcceptanceRequestSchema))
    body: z.output<typeof contractAcceptanceRequestSchema>,
  ) {
    return this.contracts.requestAcceptance(patientOnly(auth), id, body.role, { ip: actor.ip });
  }

  @SelfService()
  @Post(':id/acceptance')
  @ZodResponse(contractViewSchema)
  accept(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(contractAcceptSchema)) body: z.output<typeof contractAcceptSchema>,
  ) {
    return this.contracts.accept(actor, patientOnly(auth), id, body.role, body.code, {
      ip: actor.ip,
    });
  }
}
