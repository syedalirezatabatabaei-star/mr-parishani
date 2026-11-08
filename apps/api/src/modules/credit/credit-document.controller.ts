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
  creditDocumentChecklistViewSchema,
  creditDocumentLinkSchema,
  creditDocumentViewSchema,
  decideCreditDocumentSchema,
  uploadCreditDocumentSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  CurrentAuth,
  RequirePermission,
  SelfService,
  type AuthContext,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { CreditDocumentService } from './credit-document.service';

/** The hard ceiling of an upload; the configured policy (credit.document_policy) is checked within. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

/** A borrower's or guarantor's own documents (task 3-5 part C; self-service, rule 13). */
@Controller('me/credit-applications')
export class PatientCreditDocumentController {
  constructor(private readonly documents: CreditDocumentService) {}

  @SelfService()
  @Get(':id/documents')
  @ZodResponse(creditDocumentChecklistViewSchema)
  mine(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.documents.mine(patientOnly(auth), id);
  }

  /** In memory only (never written to disk), scanned before it is kept. */
  @SelfService()
  @Post(':id/documents')
  @ZodResponse(creditDocumentViewSchema)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(uploadCreditDocumentSchema))
    body: z.output<typeof uploadCreditDocumentSchema>,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    return this.documents.upload(actor, patientOnly(auth), id, body, file);
  }

  @SelfService()
  @Get(':id/documents/:documentId/link')
  @ZodResponse(creditDocumentLinkSchema)
  link(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ) {
    return this.documents.ownLink(actor, patientOnly(auth), id, documentId);
  }
}

/** Documents for the credit units: read, open (logged), and decide (case completion). */
@Controller('credit/applications')
export class CreditDocumentController {
  constructor(private readonly documents: CreditDocumentService) {}

  @RequirePermission('credit.read_applications')
  @Get(':id/documents')
  @ZodResponse(creditDocumentChecklistViewSchema)
  list(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.documents.forStaff(access, id);
  }

  @RequirePermission('credit.read_applications')
  @Get(':id/documents/:documentId/link')
  @ZodResponse(creditDocumentLinkSchema)
  link(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ) {
    return this.documents.staffLink(actor, access, id, documentId);
  }

  @RequirePermission('credit.complete_applications')
  @Post(':id/documents/:documentId/decision')
  @ZodResponse(creditDocumentViewSchema)
  decide(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new ZodBody(decideCreditDocumentSchema))
    body: z.output<typeof decideCreditDocumentSchema>,
  ) {
    return this.documents.decide(actor, access, id, documentId, body);
  }
}
