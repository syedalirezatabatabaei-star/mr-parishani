import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  cancelStatementSchema,
  statementQuerySchema,
  statementViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { StatementService } from './statement.service';

/**
 * Doctors' monthly statements (task 5-4): made by the worker; read by accounting; a draft
 * cancelled by two of them. Review, approval and payment come in task 5-5.
 */
@Controller('settlement/statements')
export class StatementController {
  constructor(private readonly statements: StatementService) {}

  @RequirePermission('settlement.read_statements')
  @Get()
  @ZodResponse(z.array(statementViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(statementQuerySchema)) query: z.output<typeof statementQuerySchema>,
  ) {
    return this.statements.list(actor, access, query);
  }

  @RequirePermission('settlement.read_statements')
  @Get(':id')
  @ZodResponse(statementViewSchema)
  get(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.statements.get(actor, access, id);
  }

  @RequirePermission('settlement.cancel_statement')
  @Post(':id/cancel')
  @ZodResponse(statementViewSchema)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(cancelStatementSchema)) body: z.output<typeof cancelStatementSchema>,
  ) {
    return this.statements.cancel(actor, access, id, body.reason);
  }
}
