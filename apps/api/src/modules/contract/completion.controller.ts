import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  completionReceiptViewSchema,
  completionStatusSchema,
  contractLinkSchema,
  downPaymentPostingViewSchema,
  rejectCompletionReceiptSchema,
  uploadCompletionReceiptSchema,
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
import { CompletionService } from './completion.service';
import { DownPaymentService } from './down-payment.service';

/** The hard ceiling of a receipt's file. */
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

/** Completion and its receipts, for case completion and finance (task 4-3, doc 12 §4). */
@Controller()
export class CompletionController {
  constructor(
    private readonly completion: CompletionService,
    private readonly downPayments: DownPaymentService,
  ) {}

  /** ADR-034: before funding, finance reverses a down payment's posting with a reason. */
  @RequirePermission('repayment.approve_payment')
  @Post('receipts/:id/reverse-down-payment')
  @ZodResponse(downPaymentPostingViewSchema)
  reverseDownPayment(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(rejectCompletionReceiptSchema))
    body: z.output<typeof rejectCompletionReceiptSchema>,
  ) {
    return this.downPayments.reverse(actor, access, id, body.reason);
  }

  @RequireAnyPermission('contract.read', 'repayment.approve_payment')
  @Get('completion/:applicationId')
  @ZodResponse(completionStatusSchema)
  status(
    @CurrentAccess() access: EffectiveAccess,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
  ) {
    return this.completion.status(access, applicationId);
  }

  @RequirePermission('contract.complete')
  @Post('completion/:applicationId/complete')
  @ZodResponse(completionStatusSchema)
  complete(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
  ) {
    return this.completion.complete(actor, access, applicationId);
  }

  @RequirePermission('repayment.approve_payment')
  @Get('receipts')
  @ZodResponse(z.array(completionReceiptViewSchema))
  pending(@CurrentAccess() access: EffectiveAccess) {
    return this.completion.pending(access);
  }

  @RequirePermission('repayment.approve_payment')
  @Post('receipts/:id/approve')
  @ZodResponse(completionReceiptViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.completion.approve(actor, access, id);
  }

  @RequirePermission('repayment.approve_payment')
  @Post('receipts/:id/reject')
  @ZodResponse(completionReceiptViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(rejectCompletionReceiptSchema))
    body: z.output<typeof rejectCompletionReceiptSchema>,
  ) {
    return this.completion.reject(actor, access, id, body.reason);
  }

  @RequireAnyPermission('repayment.approve_payment', 'contract.read')
  @Get('receipts/:id/link')
  @ZodResponse(contractLinkSchema)
  link(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.completion.link(actor, access, id);
  }
}

/** The patient's or borrower's side: what is owed, and uploading a receipt. */
@Controller('me/completion')
export class MyCompletionController {
  constructor(private readonly completion: CompletionService) {}

  @SelfService()
  @Get(':applicationId')
  @ZodResponse(completionStatusSchema)
  mine(
    @CurrentAuth() auth: AuthContext,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
  ) {
    return this.completion.mine(patientOnly(auth), applicationId);
  }

  /** In memory only (never written to disk), scanned before it is kept. */
  @SelfService()
  @Post(':applicationId/receipts')
  @ZodResponse(completionReceiptViewSchema)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  upload(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
    @Body(new ZodBody(uploadCompletionReceiptSchema))
    body: z.output<typeof uploadCompletionReceiptSchema>,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    return this.completion.upload(actor, patientOnly(auth), applicationId, body, file);
  }
}
