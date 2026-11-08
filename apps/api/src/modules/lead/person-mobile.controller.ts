import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { myPersonMobilesSchema, personMobileDecisionSchema } from '@sepehr/contracts';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAuth, SelfService, type AuthContext } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodResponse } from '../../common/zod-response';
import { PersonMobileApprovalService } from './person-mobile-approval.service';

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

/**
 * A patient's side of pending mobiles (task 9-3, method الف): whether their own mobile is
 * pending, and approving or refusing one added to their Person. Self-service; the service
 * checks the mobile of this login is a proved one of that Person (rule 13).
 */
@Controller('person-mobiles')
export class PersonMobileController {
  constructor(private readonly approvals: PersonMobileApprovalService) {}

  @SelfService()
  @Get('mine')
  @ZodResponse(myPersonMobilesSchema)
  mine(@CurrentAuth() auth: AuthContext) {
    return this.approvals.mine(patientOnly(auth));
  }

  @SelfService()
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(personMobileDecisionSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.approvals.decideAsOwner(actor, patientOnly(auth), id, 'approved');
  }

  @SelfService()
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(personMobileDecisionSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.approvals.decideAsOwner(actor, patientOnly(auth), id, 'rejected');
  }
}
