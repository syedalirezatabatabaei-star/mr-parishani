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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  assignTicketSchema,
  flagTicketMessageSchema,
  openCenterTicketSchema,
  openTicketOnBehalfSchema,
  openTicketSchema,
  reopenTicketSchema,
  staffTicketMessageSchema,
  staffTicketViewSchema,
  ticketAgentSchema,
  ticketAttachmentFieldsSchema,
  ticketAttachmentLinkSchema,
  ticketMessageSchema,
  ticketQueueQuerySchema,
  ticketQueueRowSchema,
  ticketStatusChangeSchema,
  ticketSummarySchema,
  ticketTopicOptionSchema,
  ticketViewSchema,
  transferTicketSchema,
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
import { TicketService } from './ticket.service';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const created = z.object({ id: z.uuid() });
type File = { buffer: Buffer } | undefined;
type Fields = z.output<typeof ticketAttachmentFieldsSchema>;

/** A patient's own tickets (task 7-1; doc 17 §1): only public messages and files (test 3). */
@Controller('me/tickets')
export class PatientTicketController {
  constructor(private readonly tickets: TicketService) {}

  @SelfService()
  @Get('topics')
  @ZodResponse(z.array(ticketTopicOptionSchema))
  topics() {
    return this.tickets.topicsFor('patient');
  }

  @SelfService()
  @Get()
  @ZodResponse(z.array(ticketSummarySchema))
  async list(@CurrentAuth() auth: AuthContext) {
    return this.tickets.listFor(await this.tickets.patient(auth.accountId));
  }

  @SelfService()
  @Post()
  @ZodResponse(ticketViewSchema)
  async open(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(openTicketSchema)) body: z.output<typeof openTicketSchema>,
  ) {
    return this.tickets.openForPatient(actor, await this.tickets.patient(auth.accountId), body);
  }

  @SelfService()
  @Get(':id')
  @ZodResponse(ticketViewSchema)
  async view(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tickets.viewFor(await this.tickets.patient(auth.accountId), id);
  }

  @SelfService()
  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ticketViewSchema)
  async reply(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ticketMessageSchema)) body: z.output<typeof ticketMessageSchema>,
  ) {
    const party = await this.tickets.patient(auth.accountId);
    return this.tickets.replyAsRequester(
      actor,
      party,
      id,
      body.body,
      undefined,
      body.containsTreatment,
    );
  }

  @SelfService()
  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ticketViewSchema)
  async reopen(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(reopenTicketSchema)) body: z.output<typeof reopenTicketSchema>,
  ) {
    const party = await this.tickets.patient(auth.accountId);
    return this.tickets.reopen(actor, party, id, body.reason);
  }

  @SelfService()
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ticketViewSchema)
  async close(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tickets.closeAsRequester(actor, await this.tickets.patient(auth.accountId), id);
  }

  @SelfService()
  @Post(':id/attachments')
  @ZodResponse(created)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }),
  )
  async attach(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ticketAttachmentFieldsSchema)) body: Fields,
    @UploadedFile() file: File,
  ) {
    const party = await this.tickets.patient(auth.accountId);
    return this.tickets.attach(actor, { party }, id, file, {
      containsTreatment: body.containsTreatment === 'true',
      visibility: body.visibility,
    });
  }

  @SelfService()
  @Get(':id/attachments/:attachmentId/link')
  @ZodResponse(ticketAttachmentLinkSchema)
  async link(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
  ) {
    const party = await this.tickets.patient(auth.accountId);
    return this.tickets.attachmentLink({ party }, id, attachmentId);
  }
}

/** A center's tickets, from a node of the caller's scope (task 7-1): public part only. */
@Controller('panel/tickets')
export class CenterTicketController {
  constructor(private readonly tickets: TicketService) {}

  @RequirePermission('ticket.open_center')
  @Get('topics')
  @ZodResponse(z.array(ticketTopicOptionSchema))
  topics() {
    return this.tickets.topicsFor('center');
  }

  @RequirePermission('ticket.open_center')
  @Get()
  @ZodResponse(z.array(ticketSummarySchema))
  list(@CurrentAuth() auth: AuthContext, @CurrentAccess() access: EffectiveAccess) {
    return this.tickets.listFor(this.tickets.center(auth.accountId, access));
  }

  @RequirePermission('ticket.open_center')
  @Post()
  @ZodResponse(ticketViewSchema)
  open(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(openCenterTicketSchema)) body: z.output<typeof openCenterTicketSchema>,
  ) {
    return this.tickets.openForCenter(actor, this.tickets.center(auth.accountId, access), body);
  }

  @RequirePermission('ticket.open_center')
  @Get(':id')
  @ZodResponse(ticketViewSchema)
  view(
    @CurrentAuth() auth: AuthContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tickets.viewFor(this.tickets.center(auth.accountId, access), id);
  }

  @RequirePermission('ticket.open_center')
  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ticketViewSchema)
  reply(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ticketMessageSchema)) body: z.output<typeof ticketMessageSchema>,
  ) {
    const party = this.tickets.center(auth.accountId, access);
    return this.tickets.replyAsRequester(
      actor,
      party,
      id,
      body.body,
      undefined,
      body.containsTreatment,
    );
  }

  @RequirePermission('ticket.open_center')
  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ticketViewSchema)
  reopen(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(reopenTicketSchema)) body: z.output<typeof reopenTicketSchema>,
  ) {
    const party = this.tickets.center(auth.accountId, access);
    return this.tickets.reopen(actor, party, id, body.reason);
  }

  @RequirePermission('ticket.open_center')
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ticketViewSchema)
  close(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tickets.closeAsRequester(actor, this.tickets.center(auth.accountId, access), id);
  }

  @RequirePermission('ticket.open_center')
  @Post(':id/attachments')
  @ZodResponse(created)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }),
  )
  attach(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ticketAttachmentFieldsSchema)) body: Fields,
    @UploadedFile() file: File,
  ) {
    const party = this.tickets.center(auth.accountId, access);
    return this.tickets.attach(actor, { party }, id, file, {
      containsTreatment: body.containsTreatment === 'true',
      visibility: body.visibility,
    });
  }

  @RequirePermission('ticket.open_center')
  @Get(':id/attachments/:attachmentId/link')
  @ZodResponse(ticketAttachmentLinkSchema)
  link(
    @CurrentAuth() auth: AuthContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
  ) {
    const party = this.tickets.center(auth.accountId, access);
    return this.tickets.attachmentLink({ party }, id, attachmentId);
  }
}

/** The units' queues (task 7-1): each unit its own; managers and read-only roles all. */
@Controller('tickets')
export class StaffTicketController {
  constructor(private readonly tickets: TicketService) {}

  @RequireAnyPermission('ticket.work', 'ticket.assign', 'ticket.read_all')
  @Get('queue')
  @ZodResponse(z.array(ticketQueueRowSchema))
  queue(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(ticketQueueQuerySchema)) query: z.output<typeof ticketQueueQuerySchema>,
  ) {
    return this.tickets.queue(access, {
      unit: query.unit,
      status: query.status,
      mine: query.mine === 'true',
    });
  }

  /** Task 7-7: a unit's agents to assign to, by name (ticket.assign). */
  @RequirePermission('ticket.assign')
  @Get('units/:unit/agents')
  @ZodResponse(z.array(ticketAgentSchema))
  agents(
    @CurrentAccess() access: EffectiveAccess,
    @Param('unit', new ZodBody(z.string().regex(/^[a-z][a-z_]{1,39}$/))) unit: string,
  ) {
    return this.tickets.unitAgents(access, unit);
  }

  /** Task 7-7: the topics a caller's ticket may take (none financial: 7-2 ج۴). */
  @RequirePermission('ticket.open_on_behalf')
  @Get('topics')
  @ZodResponse(z.array(ticketTopicOptionSchema))
  topics() {
    return this.tickets.topicsFor('patient');
  }

  @RequirePermission('ticket.open_on_behalf')
  @Post()
  @ZodResponse(staffTicketViewSchema)
  open(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(openTicketOnBehalfSchema)) body: z.output<typeof openTicketOnBehalfSchema>,
  ) {
    return this.tickets.openOnBehalf(actor, access, body);
  }

  @RequireAnyPermission('ticket.work', 'ticket.assign', 'ticket.read_all')
  @Get(':id')
  @ZodResponse(staffTicketViewSchema)
  view(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tickets.staffView(access, id);
  }

  @RequireAnyPermission('ticket.work', 'ticket.assign')
  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(staffTicketViewSchema)
  reply(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(staffTicketMessageSchema)) body: z.output<typeof staffTicketMessageSchema>,
  ) {
    return this.tickets.replyAsStaff(actor, access, id, body);
  }

  @RequireAnyPermission('ticket.work', 'ticket.assign')
  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(staffTicketViewSchema)
  status(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ticketStatusChangeSchema)) body: z.output<typeof ticketStatusChangeSchema>,
  ) {
    return this.tickets.changeStatus(actor, access, id, body);
  }

  @RequireAnyPermission('ticket.work', 'ticket.assign')
  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(staffTicketViewSchema)
  transfer(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(transferTicketSchema)) body: z.output<typeof transferTicketSchema>,
  ) {
    return this.tickets.transfer(actor, access, id, body);
  }

  @RequirePermission('ticket.assign')
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(staffTicketViewSchema)
  assign(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(assignTicketSchema)) body: z.output<typeof assignTicketSchema>,
  ) {
    return this.tickets.assign(actor, access, id, body);
  }

  @RequireAnyPermission('ticket.work', 'ticket.assign')
  @Post(':id/attachments')
  @ZodResponse(created)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }),
  )
  attach(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ticketAttachmentFieldsSchema)) body: Fields,
    @UploadedFile() file: File,
  ) {
    return this.tickets.attach(actor, { access }, id, file, {
      containsTreatment: body.containsTreatment === 'true',
      visibility: body.visibility,
    });
  }

  @RequireAnyPermission('ticket.work', 'ticket.assign', 'ticket.read_all')
  @Get(':id/attachments/:attachmentId/link')
  @ZodResponse(ticketAttachmentLinkSchema)
  link(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
  ) {
    return this.tickets.attachmentLink({ access }, id, attachmentId);
  }

  @RequireAnyPermission('ticket.work', 'ticket.assign')
  @Post(':id/messages/:messageId/flag')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(staffTicketViewSchema)
  flag(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Body(new ZodBody(flagTicketMessageSchema)) body: z.output<typeof flagTicketMessageSchema>,
  ) {
    return this.tickets.flagMessage(actor, access, id, messageId, body.reason);
  }
}

/**
 * A patient's complaint about a doctor, in that doctor's panel (task 7-2; doc 17 §1): the
 * public part only, never the patient's contact, and the doctor's answer.
 */
@Controller('panel/complaints')
export class ComplaintResponseController {
  constructor(private readonly tickets: TicketService) {}

  @RequirePermission('ticket.respond')
  @Get()
  @ZodResponse(z.array(ticketSummarySchema))
  list(@CurrentAccess() access: EffectiveAccess) {
    return this.tickets.complaintsFor(access);
  }

  @RequirePermission('ticket.respond')
  @Get(':id')
  @ZodResponse(ticketViewSchema)
  view(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tickets.complaintFor(access, id);
  }

  @RequirePermission('ticket.respond')
  @Post(':id/respond')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ticketViewSchema)
  respond(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ticketMessageSchema)) body: z.output<typeof ticketMessageSchema>,
  ) {
    return this.tickets.respond(actor, access, id, body.body);
  }
}
