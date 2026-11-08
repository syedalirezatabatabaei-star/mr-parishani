import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  addWorkplaceSchema,
  registerDoctorSchema,
  createSecretarySchema,
  delegateSecretarySchema,
  linkDoctorAccountSchema,
  setWorkplaceCreditSchema,
  updateDoctorSchema,
  scopedWorkplaceListSchema,
  delegationViewSchema,
  doctorDetailSchema,
  doctorViewSchema,
  secretaryViewSchema,
  workplaceViewSchema,
  doctorListSchema,
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
import { DoctorService } from './doctor.service';

/**
 * Doctors, their workplaces and secretaries (task 2-3). The guard checks the endpoint's
 * permission; the service checks it again with the doctor's workplaces and who is asking
 * (rules 12 and 13).
 */
@Controller('catalog')
export class DoctorController {
  constructor(private readonly doctors: DoctorService) {}

  @RequirePermission('catalog.manage_doctors')
  @Post('doctors')
  @ZodResponse(doctorViewSchema)
  register(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(registerDoctorSchema)) body: z.output<typeof registerDoctorSchema>,
  ) {
    return this.doctors.register(actor, access, body);
  }

  /** The workplaces the caller covers (task 2-11, the center panel). */
  @RequireAnyPermission(
    'catalog.read_doctors',
    'booking.read_appointments',
    'booking.read_calendar',
  )
  @Get('workplaces')
  @ZodResponse(scopedWorkplaceListSchema)
  workplaces(@CurrentAccess() access: EffectiveAccess) {
    return this.doctors.workplacesInScope(access);
  }

  @RequirePermission('catalog.read_doctors')
  @Get('doctors')
  @ZodResponse(doctorListSchema)
  list(@CurrentAccess() access: EffectiveAccess) {
    return this.doctors.list(access);
  }

  @RequirePermission('catalog.read_doctors')
  @Get('doctors/:id')
  @ZodResponse(doctorDetailSchema)
  get(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.doctors.get(actor, access, id);
  }

  @RequirePermission('catalog.manage_doctors')
  @Patch('doctors/:id')
  @ZodResponse(doctorViewSchema)
  update(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateDoctorSchema)) body: z.output<typeof updateDoctorSchema>,
  ) {
    return this.doctors.update(actor, access, id, body);
  }

  @RequirePermission('catalog.manage_doctors')
  @Post('doctors/:id/workplaces')
  @ZodResponse(workplaceViewSchema)
  addWorkplace(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(addWorkplaceSchema)) body: z.output<typeof addWorkplaceSchema>,
  ) {
    return this.doctors.addWorkplace(actor, access, id, body);
  }

  @RequirePermission('catalog.manage_doctors')
  @Post('doctors/:id/account')
  @ZodResponse(doctorViewSchema)
  linkAccount(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(linkDoctorAccountSchema)) body: z.output<typeof linkDoctorAccountSchema>,
  ) {
    return this.doctors.linkAccount(actor, access, id, body);
  }

  /** Whether the workplace takes Sepehr credit (task 2-7 decision 2): the network specialist. */
  @RequirePermission('catalog.manage_workplace_credit')
  @Put('workplaces/:id/credit')
  @ZodResponse(workplaceViewSchema)
  setCredit(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(setWorkplaceCreditSchema)) body: z.output<typeof setWorkplaceCreditSchema>,
  ) {
    return this.doctors.setCredit(actor, access, id, body);
  }

  @RequirePermission('catalog.manage_doctors')
  @Post('secretaries')
  @ZodResponse(secretaryViewSchema)
  createSecretary(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createSecretarySchema)) body: z.output<typeof createSecretarySchema>,
  ) {
    return this.doctors.createSecretary(actor, access, body);
  }

  /** For a doctor without an account; a doctor with one uses POST /access/org-nodes/:id/assignments. */
  @RequirePermission('catalog.manage_doctors')
  @Post('secretaries/:id/assignments')
  @ZodResponse(delegationViewSchema)
  delegate(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(delegateSecretarySchema)) body: z.output<typeof delegateSecretarySchema>,
  ) {
    return this.doctors.delegate(actor, access, id, body);
  }
}
