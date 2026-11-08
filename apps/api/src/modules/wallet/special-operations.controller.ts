import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  decideSpecialOperationSchema,
  doctorCandidateSchema,
  doctorCandidatesQuerySchema,
  requestSpecialOperationSchema,
  specialOperationQuerySchema,
  specialOperationViewSchema,
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
import { SpecialOperationsService } from './special-operations.service';

/** Special operations on a purse (doc 12 §7; task 4-8): asked by finance, decided by another. */
@Controller('wallet/special-operations')
export class SpecialOperationsController {
  constructor(private readonly operations: SpecialOperationsService) {}

  @RequireAnyPermission('wallet.request_special_operation', 'wallet.request_doctor_change')
  @Post()
  @ZodResponse(specialOperationViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(requestSpecialOperationSchema))
    body: z.output<typeof requestSpecialOperationSchema>,
  ) {
    return this.operations.request(actor, access, body);
  }

  @RequireAnyPermission(
    'wallet.request_special_operation',
    'wallet.approve_special_operation',
    'wallet.request_doctor_change',
    'wallet.approve_doctor_change',
  )
  @Get()
  @ZodResponse(z.array(specialOperationViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(specialOperationQuerySchema))
    query: z.output<typeof specialOperationQuerySchema>,
  ) {
    return this.operations.list(actor, access, query);
  }

  @RequireAnyPermission('wallet.approve_special_operation', 'wallet.approve_doctor_change')
  @Post(':id/approve')
  @ZodResponse(specialOperationViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideSpecialOperationSchema))
    body: z.output<typeof decideSpecialOperationSchema>,
  ) {
    return this.operations.approve(actor, access, id, body.reason);
  }

  @RequireAnyPermission('wallet.approve_special_operation', 'wallet.approve_doctor_change')
  @Post(':id/reject')
  @ZodResponse(specialOperationViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideSpecialOperationSchema))
    body: z.output<typeof decideSpecialOperationSchema>,
  ) {
    return this.operations.reject(actor, access, id, body.reason);
  }
}

/** The «new doctor» picker (f7, owner 1405/07/23, plan 2): a read, nothing written. */
@Controller('wallet/purses')
export class PurseDoctorCandidatesController {
  constructor(private readonly operations: SpecialOperationsService) {}

  @RequirePermission('wallet.request_doctor_change')
  @Get(':id/doctor-candidates')
  @ZodResponse(z.array(doctorCandidateSchema))
  candidates(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(doctorCandidatesQuerySchema))
    query: z.output<typeof doctorCandidatesQuerySchema>,
  ) {
    return this.operations.doctorCandidates(access, id, query.q);
  }
}
