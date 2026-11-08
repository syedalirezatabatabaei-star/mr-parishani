import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  grantOriginationDiscountSchema,
  originationDiscountCandidateSchema,
  originationDiscountCandidatesQuerySchema,
  originationDiscountReportRowSchema,
  originationDiscountsQuerySchema,
  originationDiscountViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { OriginationDiscountService } from './origination-discount.service';

/** The signed file's hard ceiling, as a receipt's. */
const MAX_SIGNED_BYTES = 10 * 1024 * 1024;

/** ADR-048: an officer's discount on the origination fee, and the month's list. */
@Controller()
export class OriginationDiscountController {
  constructor(private readonly discounts: OriginationDiscountService) {}

  /** In memory only (never written to disk), scanned before it is kept. */
  @RequirePermission('contract.grant_origination_discount')
  @Post('completion/:applicationId/origination-discount')
  @ZodResponse(originationDiscountViewSchema)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SIGNED_BYTES, files: 1 } }))
  grant(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
    @Body(new ZodBody(grantOriginationDiscountSchema))
    body: z.output<typeof grantOriginationDiscountSchema>,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    return this.discounts.grant(actor, access, applicationId, body, file);
  }

  /** Owner 1405/08/02 (plan item ب): the club officer's search by mobile. */
  @RequirePermission('contract.grant_origination_discount')
  @Get('origination-discounts/candidates')
  @ZodResponse(z.array(originationDiscountCandidateSchema))
  candidates(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(originationDiscountCandidatesQuerySchema))
    query: z.output<typeof originationDiscountCandidatesQuerySchema>,
  ) {
    return this.discounts.candidates(access, query.mobile);
  }

  @RequirePermission('contract.read_origination_discounts')
  @Get('origination-discounts')
  @ZodResponse(z.array(originationDiscountReportRowSchema))
  month(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(originationDiscountsQuerySchema))
    query: z.output<typeof originationDiscountsQuerySchema>,
  ) {
    return this.discounts.month(access, query.month);
  }
}
