import {
  Body,
  Controller,
  Get,
  Header,
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
  assignCollectionItemSchema,
  borrowerStatusEventSchema,
  collectionItemSchema,
  collectionQueueQuerySchema,
  collectionQueueRowSchema,
  createPaymentPromiseSchema,
  decideCollectionTaskSchema,
  proposedTaskSchema,
  proposeBorrowerStatusSchema,
  reasonSchema,
  recordCollectionActionSchema,
  smsPreviewQuerySchema,
  smsPreviewSchema,
  workCollectionTaskSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { CollectionService } from './collection.service';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const id = z.object({ id: z.uuid() });
const taskState = z.object({
  id: z.uuid(),
  status: z.enum(['open', 'proposed', 'done', 'dismissed']),
});

/**
 * The collection unit (task 6-7; doc 15 §5): the queue, a case's follow-up, actions,
 * promises, tasks and a borrower's deceased or disabled status. Every response is of a
 * shape without treatment, doctor or center (doc 04 §4), and the field filter strips them
 * again besides.
 */
@Controller('collection')
export class CollectionController {
  constructor(private readonly collection: CollectionService) {}

  @RequirePermission('collection.read_queue')
  @Get('queue')
  @ZodResponse(z.array(collectionQueueRowSchema))
  queue(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(collectionQueueQuerySchema))
    query: z.output<typeof collectionQueueQuerySchema>,
  ) {
    return this.collection.queue(actor, access, query);
  }

  @RequirePermission('collection.read_queue')
  @Get('queue.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="collection-queue.csv"')
  queueCsv(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(collectionQueueQuerySchema))
    query: z.output<typeof collectionQueueQuerySchema>,
  ) {
    return this.collection.queueCsv(actor, access, query);
  }

  @RequirePermission('collection.read_queue')
  @Get('items/:id')
  @ZodResponse(collectionItemSchema)
  item(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) itemId: string,
  ) {
    return this.collection.item(actor, access, itemId);
  }

  @RequirePermission('collection.read_queue')
  @Get('items/:id/sms-preview')
  @ZodResponse(smsPreviewSchema)
  smsPreview(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) itemId: string,
    @Query(new ZodBody(smsPreviewQuerySchema)) query: z.output<typeof smsPreviewQuerySchema>,
  ) {
    return this.collection.smsPreview(actor, access, itemId, query.audience);
  }

  @RequirePermission('collection.record_action')
  @Post('items/:id/actions')
  @ZodResponse(id)
  recordAction(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) itemId: string,
    @Body(new ZodBody(recordCollectionActionSchema))
    body: z.output<typeof recordCollectionActionSchema>,
  ) {
    return this.collection.recordAction(actor, access, itemId, body);
  }

  @RequirePermission('collection.manage_promises')
  @Post('items/:id/promises')
  @ZodResponse(id)
  createPromise(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) itemId: string,
    @Body(new ZodBody(createPaymentPromiseSchema))
    body: z.output<typeof createPaymentPromiseSchema>,
  ) {
    return this.collection.createPromise(actor, access, itemId, body);
  }

  @RequirePermission('collection.manage_promises')
  @Post('promises/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(z.object({ id: z.uuid(), status: z.literal('cancelled') }))
  cancelPromise(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) promiseId: string,
    @Body(new ZodBody(reasonSchema)) body: z.output<typeof reasonSchema>,
  ) {
    return this.collection.cancelPromise(actor, access, promiseId, body.reason);
  }

  @RequirePermission('collection.assign')
  @Post('items/:id/assign')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(z.object({ itemId: z.uuid(), assigneeAccountId: z.uuid() }))
  assign(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) itemId: string,
    @Body(new ZodBody(assignCollectionItemSchema))
    body: z.output<typeof assignCollectionItemSchema>,
  ) {
    return this.collection.assignManually(actor, access, itemId, body);
  }

  /** Task 6-9: stage 3 and 4 proposals waiting for the collection manager. */
  @RequirePermission('collection.decide_escalation')
  @Get('tasks/proposed')
  @ZodResponse(z.array(proposedTaskSchema))
  proposedTasks(@CurrentAccess() access: EffectiveAccess) {
    return this.collection.proposedTasks(access);
  }

  @RequirePermission('collection.work_tasks')
  @Post('tasks/:id/work')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(taskState)
  workTask(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodBody(workCollectionTaskSchema)) body: z.output<typeof workCollectionTaskSchema>,
  ) {
    return this.collection.workTask(actor, access, taskId, body);
  }

  /** Stage 2: the guarantor told only by this decision (owner 1405/07/16). */
  @RequirePermission('collection.work_tasks')
  @Post('tasks/:id/send-guarantor-sms')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(taskState.extend({ dispatchIds: z.array(z.uuid()) }))
  sendGuarantorSms(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodBody(reasonSchema)) body: z.output<typeof reasonSchema>,
  ) {
    return this.collection.sendGuarantorSms(actor, access, taskId, body.reason);
  }

  @RequirePermission('collection.work_tasks')
  @Post('tasks/:id/propose')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(taskState)
  proposeTask(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodBody(reasonSchema)) body: z.output<typeof reasonSchema>,
  ) {
    return this.collection.proposeTask(actor, access, taskId, body.reason);
  }

  @RequirePermission('collection.decide_escalation')
  @Post('tasks/:id/decide')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(taskState)
  decide(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodBody(decideCollectionTaskSchema))
    body: z.output<typeof decideCollectionTaskSchema>,
  ) {
    return this.collection.decideEscalation(actor, access, taskId, body);
  }

  @RequirePermission('collection.propose_borrower_status')
  @Post('borrower-status')
  @ZodResponse(z.object({ id: z.uuid(), status: z.literal('proposed') }))
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } }))
  proposeBorrowerStatus(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(proposeBorrowerStatusSchema))
    body: z.output<typeof proposeBorrowerStatusSchema>,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.collection.proposeBorrowerStatus(actor, access, body, file);
  }

  @RequirePermission('collection.approve_borrower_status')
  @Get('borrower-status/pending')
  @ZodResponse(z.array(borrowerStatusEventSchema))
  pendingBorrowerStatus(@CurrentAccess() access: EffectiveAccess) {
    return this.collection.pendingBorrowerStatus(access);
  }

  @RequirePermission('collection.approve_borrower_status')
  @Post('borrower-status/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(z.object({ id: z.uuid(), status: z.literal('approved') }))
  approveBorrowerStatus(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) eventId: string,
  ) {
    return this.collection.approveBorrowerStatus(actor, access, eventId);
  }
}
