import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CENTER_STATUSES,
  centerTransitionSchema,
  createBranchSchema,
  registerCenterSchema,
  decideCenterRequestSchema,
  proposeBankAccountSchema,
  setDocumentStatusSchema,
  updateBranchSchema,
  updateCenterSchema,
  centerDetailSchema,
  centerListSchema,
  centerRequestListSchema,
  branchViewSchema,
  centerRequestViewSchema,
  centerBankAccountViewSchema,
  centerDocumentStatusViewSchema,
  centerViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { CenterService } from './center.service';

const listQuerySchema = z.object({ status: z.enum(CENTER_STATUSES).optional() });
const documentCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);

/**
 * Centers and branches (task 2-2). The guard checks the endpoint's permission; the
 * service checks it again with the scope and the center's status (rules 12 and 13), and
 * the permission a two-person decision needs, which depends on the request's kind.
 */
@Controller('catalog')
export class CenterController {
  constructor(private readonly centers: CenterService) {}

  @RequirePermission('catalog.manage_centers')
  @Post('centers')
  @ZodResponse(centerViewSchema)
  create(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(registerCenterSchema)) body: z.output<typeof registerCenterSchema>,
  ) {
    return this.centers.create(actor, access, body);
  }

  @RequirePermission('catalog.read_centers')
  @Get('centers')
  @ZodResponse(centerListSchema)
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(listQuerySchema)) query: z.output<typeof listQuerySchema>,
  ) {
    return this.centers.list(access, query.status);
  }

  @RequirePermission('catalog.read_centers')
  @Get('centers/:id')
  @ZodResponse(centerDetailSchema)
  get(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.centers.get(actor, access, id);
  }

  @RequirePermission('catalog.manage_centers')
  @Patch('centers/:id')
  @ZodResponse(centerViewSchema)
  update(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateCenterSchema)) body: z.output<typeof updateCenterSchema>,
  ) {
    return this.centers.update(actor, access, id, body);
  }

  @RequirePermission('catalog.view_bank_account')
  @Get('centers/:id/bank-account')
  @ZodResponse(centerBankAccountViewSchema)
  bankAccount(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.centers.bankAccount(actor, access, id);
  }

  @RequirePermission('catalog.manage_centers')
  @Post('centers/:id/branches')
  @ZodResponse(branchViewSchema)
  createBranch(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(createBranchSchema)) body: z.output<typeof createBranchSchema>,
  ) {
    return this.centers.createBranch(actor, access, id, body);
  }

  @RequirePermission('catalog.manage_centers')
  @Patch('branches/:id')
  @ZodResponse(branchViewSchema)
  updateBranch(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateBranchSchema)) body: z.output<typeof updateBranchSchema>,
  ) {
    return this.centers.updateBranch(actor, access, id, body);
  }

  /** Received needs catalog.manage_centers; verified or incomplete, review (service). */
  @RequirePermission('catalog.read_centers')
  @Put('centers/:id/documents/:code')
  @ZodResponse(centerDocumentStatusViewSchema)
  setDocumentStatus(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('code', new ZodBody(documentCodeSchema)) code: string,
    @Body(new ZodBody(setDocumentStatusSchema)) body: z.output<typeof setDocumentStatusSchema>,
  ) {
    return this.centers.setDocumentStatus(actor, access, id, code, body);
  }

  @RequirePermission('catalog.manage_centers')
  @Post('centers/:id/submit')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(centerViewSchema)
  submit(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(centerTransitionSchema)) body: z.output<typeof centerTransitionSchema>,
  ) {
    return this.centers.submit(actor, access, id, body.reason);
  }

  @RequirePermission('catalog.review_centers')
  @Post('centers/:id/needs-fix')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(centerViewSchema)
  returnForFix(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(centerTransitionSchema)) body: z.output<typeof centerTransitionSchema>,
  ) {
    return this.centers.returnForFix(actor, access, id, body.reason);
  }

  /** Activation (under review) or reactivation (suspended): step one of two. */
  @RequirePermission('catalog.review_centers')
  @Post('centers/:id/activation-requests')
  @ZodResponse(centerRequestViewSchema)
  proposeActivation(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(centerTransitionSchema)) body: z.output<typeof centerTransitionSchema>,
  ) {
    return this.centers.proposeActivation(actor, access, id, body.reason);
  }

  @RequirePermission('catalog.suspend_center')
  @Post('centers/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(centerViewSchema)
  suspend(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(centerTransitionSchema)) body: z.output<typeof centerTransitionSchema>,
  ) {
    return this.centers.suspend(actor, access, id, body.reason);
  }

  @RequirePermission('catalog.suspend_center')
  @Post('centers/:id/terminate')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(centerViewSchema)
  terminate(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(centerTransitionSchema)) body: z.output<typeof centerTransitionSchema>,
  ) {
    return this.centers.terminate(actor, access, id, body.reason);
  }

  @RequirePermission('catalog.manage_centers')
  @Post('centers/:id/bank-account-requests')
  @ZodResponse(centerRequestViewSchema)
  proposeBankAccount(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(proposeBankAccountSchema)) body: z.output<typeof proposeBankAccountSchema>,
  ) {
    return this.centers.proposeBankAccount(actor, access, id, body);
  }

  @RequirePermission('catalog.read_centers')
  @Get('requests')
  @ZodResponse(centerRequestListSchema)
  requests(@CurrentAccess() access: EffectiveAccess) {
    return this.centers.listRequests(access);
  }

  /** The permission needed depends on the request's kind; the service checks it. */
  @RequirePermission('catalog.read_centers')
  @Post('requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(centerRequestViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCenterRequestSchema)) body: z.output<typeof decideCenterRequestSchema>,
  ) {
    return this.centers.decide(actor, access, id, true, body.note);
  }

  @RequirePermission('catalog.read_centers')
  @Post('requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(centerRequestViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideCenterRequestSchema)) body: z.output<typeof decideCenterRequestSchema>,
  ) {
    return this.centers.decide(actor, access, id, false, body.note);
  }
}
