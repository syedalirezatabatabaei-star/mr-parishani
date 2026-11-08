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
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  otpRequestedSchema,
  PARTNERSHIP_DOCUMENTS,
  PARTNERSHIP_FILE_MAX_BYTES,
  PARTNERSHIP_STATUSES,
  partnershipApproveSchema,
  partnershipCodeRequestSchema,
  partnershipReceiptSchema,
  partnershipRejectSchema,
  partnershipRequestFieldsSchema,
  partnershipRequestSchema,
  partnershipReviewSchema,
  partnershipSummarySchema,
  partnershipViewSchema,
  powChallengeSchema,
} from '@sepehr/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  Public,
  RequireAnyPermission,
  RequirePermission,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { PartnershipService, type UploadedDocument } from './partnership.service';

const listQuerySchema = z.object({ status: z.enum(PARTNERSHIP_STATUSES).optional() });
type Files = Partial<Record<string, UploadedDocument[]>>;

/** The public form of a partnership request (owner 1405/08/10): no session, no cookie. */
@Controller('catalog/partnership')
export class PublicPartnershipController {
  constructor(private readonly partnership: PartnershipService) {}

  @Public()
  @Get('challenge')
  @ZodResponse(powChallengeSchema)
  challenge() {
    return this.partnership.challenge();
  }

  @Public()
  @Post('code')
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodResponse(otpRequestedSchema)
  code(
    @Body(new ZodBody(partnershipCodeRequestSchema))
    body: z.output<typeof partnershipCodeRequestSchema>,
    @Req() req: Request,
  ) {
    return this.partnership.sendCode(body, req.ip ?? null);
  }

  /** The request: its fields as JSON in `request`, each document in its own file field. */
  @Public()
  @Post('requests')
  @ZodResponse(partnershipReceiptSchema)
  @UseInterceptors(
    FileFieldsInterceptor(
      PARTNERSHIP_DOCUMENTS.map((name) => ({ name, maxCount: 1 })),
      { limits: { fileSize: PARTNERSHIP_FILE_MAX_BYTES, files: PARTNERSHIP_DOCUMENTS.length } },
    ),
  )
  submit(
    @Body(new ZodBody(partnershipRequestFieldsSchema))
    body: z.output<typeof partnershipRequestFieldsSchema>,
    @UploadedFiles() files: Files | undefined,
    @Req() req: Request,
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.request);
    } catch {
      parsed = null;
    }
    const input = new ZodBody(partnershipRequestSchema).transform(parsed);
    const documents = Object.values(files ?? {}).flatMap((list) => list ?? []);
    return this.partnership.submit(input, documents, req.ip ?? null);
  }
}

/** The network specialist's and the network manager's queue (owner 1405/08/10). */
@Controller('catalog/partnership-requests')
export class PartnershipController {
  constructor(private readonly partnership: PartnershipService) {}

  @RequireAnyPermission('catalog.review_partnership', 'catalog.approve_partnership')
  @Get()
  @ZodResponse(z.array(partnershipSummarySchema))
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(listQuerySchema)) query: z.output<typeof listQuerySchema>,
  ) {
    return this.partnership.list(access, query.status);
  }

  @RequireAnyPermission('catalog.review_partnership', 'catalog.approve_partnership')
  @Get(':id')
  @ZodResponse(partnershipViewSchema)
  view(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.partnership.view(access, id);
  }

  @RequireAnyPermission('catalog.review_partnership', 'catalog.approve_partnership')
  @Get(':id/documents/:documentId/link')
  @ZodResponse(z.object({ url: z.string(), expiresInSeconds: z.int() }))
  link(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ) {
    return this.partnership.documentLink(actor, access, id, documentId);
  }

  @RequirePermission('catalog.review_partnership')
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(partnershipViewSchema)
  review(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(partnershipReviewSchema)) body: z.output<typeof partnershipReviewSchema>,
  ) {
    return this.partnership.review(actor, access, id, body);
  }

  @RequirePermission('catalog.approve_partnership')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(partnershipViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(partnershipApproveSchema)) body: z.output<typeof partnershipApproveSchema>,
  ) {
    return this.partnership.approve(actor, access, id, body.note);
  }

  @RequireAnyPermission('catalog.review_partnership', 'catalog.approve_partnership')
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(partnershipViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(partnershipRejectSchema)) body: z.output<typeof partnershipRejectSchema>,
  ) {
    return this.partnership.reject(actor, access, id, body.reason);
  }
}
