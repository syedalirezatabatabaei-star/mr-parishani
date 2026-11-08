import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  type RawBodyRequest,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  abandonmentReasonListSchema,
  abandonmentReasonSchema,
  casePersonSchema,
  completionAlertListSchema,
  retiredSchema,
  AGENT_PRESENCE,
  agentViewSchema,
  distributionReportSchema,
  namedShareSchema,
  sharesViewSchema,
  approvePersonMobileSchema,
  assignCaseSchema,
  blockPersonSchema,
  cancelCaseSchema,
  caseDetailSchema,
  caseViewSchema,
  cancelImportSchema,
  commitImportSchema,
  createAbandonmentReasonSchema,
  distributionQuerySchema,
  intakeResultSchema,
  leadImportCancelledSchema,
  leadImportCommittedSchema,
  leadImportPreviewSchema,
  LEAD_IMPORT_LIMITS,
  manualIntakeSchema,
  mergePersonsSchema,
  mergeResultSchema,
  pendingPersonMobilesSchema,
  personMobileForStaffSchema,
  personMobileProposalSchema,
  proposePersonMobileSchema,
  personMobileDecisionSchema,
  rejectPersonMobileSchema,
  retireSchema,
  personMergeViewSchema,
  revertMergeResultSchema,
  revertMergeSchema,
  setAssignmentWeightsSchema,
  setCapSchema,
  setPresenceSchema,
  unblockPersonSchema,
  updateAbandonmentReasonSchema,
  webhookReceivedSchema,
} from '@sepehr/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, Public, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { AssignmentAdminService } from './assignment-admin.service';
import { CaseService } from './case.service';
import { LeadImportService, type UploadedSheet } from './import.service';
import { LeadIntakeService } from './intake.service';
import { requirePermission } from './lead.shared';
import { PersonMobileApprovalService } from './person-mobile-approval.service';
import { PersonService } from './person.service';
import { AbandonmentReasonService } from './reason.service';
import { LeadWebhookService } from './webhook.service';

const code = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const listQuerySchema = z.object({ open: z.enum(['true', 'false']).optional() });
const sharesQuerySchema = z.object({
  queueCode: code,
  cityCode: code.optional(),
  treatmentFieldCode: code.optional(),
});

/**
 * The WordPress form's webhook (doc 05 §7): public, because it is authenticated by its
 * HMAC signature, not a session; the service checks the signature, the time, the
 * idempotency key and the rate limits before anything is recorded.
 */
@Controller('leads')
export class LeadWebhookController {
  constructor(private readonly webhook: LeadWebhookService) {}

  @Public()
  @Post('intake')
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodResponse(webhookReceivedSchema)
  receive(@Req() req: RawBodyRequest<Request>) {
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    return this.webhook.receive(
      {
        source: header('x-sepehr-source'),
        timestamp: header('x-sepehr-timestamp'),
        signature: header('x-sepehr-signature'),
        idempotencyKey: header('idempotency-key'),
      },
      req.rawBody,
      req.ip ?? null,
    );
  }
}

/**
 * Leads, cases and persons (task 2-5b). Each endpoint has one permission; the services
 * check it again with the scope of every record (rules 12 and 13).
 */
@Controller('lead')
export class LeadController {
  constructor(
    private readonly intake: LeadIntakeService,
    private readonly cases: CaseService,
    private readonly persons: PersonService,
    private readonly reasons: AbandonmentReasonService,
    private readonly assignment: AssignmentAdminService,
    private readonly mobiles: PersonMobileApprovalService,
  ) {}

  /** An advisor enters a lead by hand; it goes through the one intake. */
  @RequirePermission('lead.intake_manual')
  @Post('intakes')
  @ZodResponse(intakeResultSchema)
  manualIntake(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(manualIntakeSchema)) body: z.output<typeof manualIntakeSchema>,
  ) {
    requirePermission(access, 'lead.intake_manual');
    return this.intake.intake(actor, {
      mobile: body.mobile,
      name: body.name ?? null,
      nationalId: body.nationalId ?? null,
      treatmentFieldCode: body.treatmentFieldCode,
      cityCode: body.cityCode ?? null,
      channel: 'advisor',
      smsConsent: body.smsConsent,
      note: body.note ?? null,
    });
  }

  @RequirePermission('lead.read_cases')
  @Get('cases')
  @ZodResponse(z.array(caseViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(listQuerySchema)) query: z.output<typeof listQuerySchema>,
  ) {
    return this.cases.list(actor, access, query.open === 'true');
  }

  /** Settled cases left to staff (owner 1405/07/15). */
  @RequirePermission('lead.read_cases')
  @Get('case-completions')
  @ZodResponse(completionAlertListSchema)
  completionAlerts(@CurrentActor() actor: Actor, @CurrentAccess() access: EffectiveAccess) {
    return this.cases.completionAlerts(actor, access);
  }

  @RequirePermission('lead.read_cases')
  @Get('cases/:id')
  @ZodResponse(caseDetailSchema)
  get(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.cases.get(actor, access, id);
  }

  @RequirePermission('lead.update_cases')
  @Post('cases/:id/advising')
  @ZodResponse(caseViewSchema)
  @HttpCode(HttpStatus.OK)
  startAdvising(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.cases.startAdvising(actor, access, id);
  }

  @RequirePermission('lead.update_cases')
  @Post('cases/:id/complete')
  @ZodResponse(caseViewSchema)
  @HttpCode(HttpStatus.OK)
  completeSettled(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.cases.completeSettled(actor, access, id);
  }

  @RequirePermission('lead.update_cases')
  @Post('cases/:id/cancel')
  @ZodResponse(caseViewSchema)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(cancelCaseSchema)) body: z.output<typeof cancelCaseSchema>,
  ) {
    return this.cases.cancel(actor, access, id, body);
  }

  @RequirePermission('lead.update_cases')
  @Post('cases/:id/sms-opt-out')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(casePersonSchema)
  smsOptOut(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(retireSchema)) body: z.output<typeof retireSchema>,
  ) {
    return this.cases.optOutOfSms(actor, access, id, body.reason);
  }

  @RequirePermission('lead.assign_manually')
  @Post('cases/:id/assignments')
  @ZodResponse(caseViewSchema)
  assign(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(assignCaseSchema)) body: z.output<typeof assignCaseSchema>,
  ) {
    return this.cases.assignManually(actor, access, id, body);
  }

  // --- abandonment reasons ----------------------------------------------------------------

  @RequirePermission('lead.read_cases')
  @Get('abandonment-reasons')
  @ZodResponse(abandonmentReasonListSchema)
  listReasons(@CurrentAccess() access: EffectiveAccess) {
    return this.reasons.list(access);
  }

  @RequirePermission('lead.manage_reasons')
  @Post('abandonment-reasons')
  @ZodResponse(abandonmentReasonSchema)
  createReason(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createAbandonmentReasonSchema))
    body: z.output<typeof createAbandonmentReasonSchema>,
  ) {
    return this.reasons.create(actor, access, body);
  }

  @RequirePermission('lead.manage_reasons')
  @Patch('abandonment-reasons/:code')
  @ZodResponse(abandonmentReasonSchema)
  updateReason(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code') reasonCode: string,
    @Body(new ZodBody(updateAbandonmentReasonSchema))
    body: z.output<typeof updateAbandonmentReasonSchema>,
  ) {
    return this.reasons.update(actor, access, reasonCode, body);
  }

  @RequirePermission('lead.manage_reasons')
  @Post('abandonment-reasons/:code/retire')
  @ZodResponse(retiredSchema)
  async retireReason(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code') reasonCode: string,
    @Body(new ZodBody(retireSchema)) body: z.output<typeof retireSchema>,
  ) {
    await this.reasons.retire(actor, access, reasonCode, body.reason);
    return { retired: true };
  }

  // --- persons ----------------------------------------------------------------------------

  @RequirePermission('lead.block_person')
  @Post('persons/:id/block')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(casePersonSchema)
  block(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(blockPersonSchema)) body: z.output<typeof blockPersonSchema>,
  ) {
    return this.persons.block(actor, access, id, body);
  }

  @RequirePermission('lead.block_person')
  @Post('persons/:id/unblock')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(casePersonSchema)
  unblock(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(unblockPersonSchema)) body: z.output<typeof unblockPersonSchema>,
  ) {
    return this.persons.unblock(actor, access, id, body.reason);
  }

  @RequirePermission('lead.merge_persons')
  @Get('persons/:id/merges')
  @ZodResponse(z.array(personMergeViewSchema))
  mergesInto(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.persons.mergesInto(access, id);
  }

  @RequirePermission('lead.merge_persons')
  @Post('person-merges')
  @ZodResponse(mergeResultSchema)
  merge(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(mergePersonsSchema)) body: z.output<typeof mergePersonsSchema>,
  ) {
    return this.persons.merge(actor, access, body);
  }

  @RequirePermission('lead.merge_persons')
  @Post('person-merges/:id/revert')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(revertMergeResultSchema)
  revertMerge(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(revertMergeSchema)) body: z.output<typeof revertMergeSchema>,
  ) {
    return this.persons.revertMerge(actor, access, id, body.reason);
  }

  // --- pending mobiles (task 9-3, method ب) ------------------------------------------------

  @RequirePermission('lead.approve_person_mobile')
  @Get('person-mobiles/pending')
  @ZodResponse(pendingPersonMobilesSchema)
  pendingMobiles(@CurrentAccess() access: EffectiveAccess) {
    return this.mobiles.pendingQueue(access);
  }

  @RequirePermission('lead.approve_person_mobile')
  @Get('person-mobiles/:id')
  @ZodResponse(personMobileForStaffSchema)
  mobileForStaff(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.mobiles.mobileForStaff(actor, access, id);
  }

  @RequirePermission('lead.approve_person_mobile')
  @Post('person-mobiles/:id/propose')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(personMobileProposalSchema)
  proposeMobile(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(proposePersonMobileSchema)) body: z.output<typeof proposePersonMobileSchema>,
  ) {
    return this.mobiles.proposeAsStaff(actor, access, id, body);
  }

  @RequirePermission('lead.approve_person_mobile')
  @Post('person-mobiles/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(personMobileDecisionSchema)
  approveMobile(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(approvePersonMobileSchema)) body: z.output<typeof approvePersonMobileSchema>,
  ) {
    return this.mobiles.decideAsStaff(actor, access, id, 'approved', body);
  }

  @RequirePermission('lead.approve_person_mobile')
  @Post('person-mobiles/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(personMobileDecisionSchema)
  rejectMobile(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(rejectPersonMobileSchema)) body: z.output<typeof rejectPersonMobileSchema>,
  ) {
    return this.mobiles.decideAsStaff(actor, access, id, 'rejected', body);
  }

  // --- assignment -------------------------------------------------------------------------

  @RequirePermission('lead.manage_assignment')
  @Put('assignment/shares')
  @ZodResponse(sharesViewSchema)
  setShares(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(setAssignmentWeightsSchema))
    body: z.output<typeof setAssignmentWeightsSchema>,
  ) {
    return this.assignment.setShares(actor, access, body);
  }

  @RequirePermission('lead.manage_assignment')
  @Get('assignment/shares')
  @ZodResponse(sharesViewSchema.extend({ shares: z.array(namedShareSchema) }).nullable())
  shares(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(sharesQuerySchema)) query: z.output<typeof sharesQuerySchema>,
  ) {
    return this.assignment.sharesWithNames(
      access,
      query.queueCode,
      query.cityCode ?? null,
      query.treatmentFieldCode ?? null,
    );
  }

  /** The assignment page (owner 1405/07/24): an agent to add, by username. */
  @RequirePermission('lead.manage_assignment')
  @Get('agents/by-username/:username')
  @ZodResponse(agentViewSchema)
  agent(@CurrentAccess() access: EffectiveAccess, @Param('username') username: string) {
    return this.assignment.findAgent(access, username);
  }

  @RequirePermission('lead.manage_assignment')
  @Put('agents/:accountId/presence')
  @ZodResponse(z.object({ accountId: z.uuid(), status: z.enum(AGENT_PRESENCE) }))
  setPresence(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Body(new ZodBody(setPresenceSchema)) body: z.output<typeof setPresenceSchema>,
  ) {
    return this.assignment.setPresence(actor, access, accountId, body);
  }

  @RequirePermission('lead.manage_assignment')
  @Put('agents/:accountId/cap')
  @ZodResponse(z.object({ accountId: z.uuid(), maxOpenCases: z.int().nullable() }))
  setCap(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Body(new ZodBody(setCapSchema)) body: z.output<typeof setCapSchema>,
  ) {
    return this.assignment.setCap(actor, access, accountId, body);
  }

  @RequirePermission('lead.read_distribution_report')
  @Get('assignment/distribution')
  @ZodResponse(distributionReportSchema)
  distribution(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(distributionQuerySchema)) query: z.output<typeof distributionQuerySchema>,
  ) {
    return this.assignment.distribution(access, query);
  }
}

/** The Excel import of patients and leads (doc 05 §8), behind `lead.excel_import_enabled`. */
@Controller('lead/imports')
export class LeadImportController {
  constructor(private readonly imports: LeadImportService) {}

  @RequirePermission('lead.import')
  @Get('template')
  @Header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @Header('content-disposition', 'attachment; filename="lead-import.xlsx"')
  template(@CurrentAccess() access: EffectiveAccess) {
    return new StreamableFile(this.imports.template(access));
  }

  /** In memory only (never written to disk), within the size limit. */
  @RequirePermission('lead.import')
  @Post()
  @ZodResponse(leadImportPreviewSchema)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: LEAD_IMPORT_LIMITS.maxFileBytes, files: 1 } }),
  )
  upload(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @UploadedFile() file: UploadedSheet | undefined,
  ) {
    return this.imports.upload(actor, access, file);
  }

  @RequirePermission('lead.import')
  @Get(':id')
  @ZodResponse(leadImportPreviewSchema)
  get(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.imports.get(access, id);
  }

  @RequirePermission('lead.import')
  @Post(':id/commit')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(leadImportCommittedSchema)
  commit(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(commitImportSchema)) body: z.output<typeof commitImportSchema>,
  ) {
    return this.imports.commit(actor, access, id, body.reason);
  }

  @RequirePermission('lead.import')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(leadImportCancelledSchema)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(cancelImportSchema)) body: z.output<typeof cancelImportSchema>,
  ) {
    return this.imports.cancel(actor, access, id, body.reason);
  }

  @RequirePermission('lead.import')
  @Get(':id/report.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="lead-import-report.csv"')
  report(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.imports.report(access, id);
  }
}
