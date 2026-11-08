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
  clubMembershipsQuerySchema,
  clubMembershipViewSchema,
  recordClubMembershipSchema,
  revokeClubMembershipSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { ClubMembershipService } from './club-membership.service';

/** The customer club's memberships (ADR-048): the club officer only. */
@Controller('lead/club-memberships')
export class ClubMembershipController {
  constructor(private readonly club: ClubMembershipService) {}

  @RequirePermission('lead.record_club_membership')
  @Get()
  @ZodResponse(z.array(clubMembershipViewSchema))
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(clubMembershipsQuerySchema))
    query: z.output<typeof clubMembershipsQuerySchema>,
  ) {
    return this.club.list(access, query.mobile);
  }

  @RequirePermission('lead.record_club_membership')
  @Post()
  @ZodResponse(clubMembershipViewSchema)
  record(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(recordClubMembershipSchema))
    body: z.output<typeof recordClubMembershipSchema>,
  ) {
    return this.club.record(actor, access, body);
  }

  @RequirePermission('lead.record_club_membership')
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(clubMembershipViewSchema)
  revoke(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(revokeClubMembershipSchema))
    body: z.output<typeof revokeClubMembershipSchema>,
  ) {
    return this.club.revoke(actor, access, id, body);
  }
}
