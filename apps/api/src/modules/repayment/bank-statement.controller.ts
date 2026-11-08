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
  bankStatementImportSchema,
  bankStatementPreviewSchema,
  bankStatementRowSchema,
  bankStatementRowsQuerySchema,
  reviewBankRowSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import { RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { BankStatementService } from './bank-statement.service';

const MAX_BYTES = 5 * 1024 * 1024;
const mapField = z.object({ map: z.string().max(2_000).optional() });

/**
 * Bank statements (task 6-3): previewed with a mapping, imported, each row a suggested slip
 * or an unknown deposit; accounting only. Nothing here posts or approves anything.
 */
@Controller('repayment/bank-statements')
export class BankStatementController {
  constructor(private readonly statements: BankStatementService) {}

  @RequirePermission('repayment.approve_payment')
  @Post('preview')
  @ZodResponse(bankStatementPreviewSchema)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  preview(
    @Body(new ZodBody(mapField)) body: z.output<typeof mapField>,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.statements.preview(file, body.map);
  }

  @RequirePermission('repayment.approve_payment')
  @Post()
  @ZodResponse(bankStatementImportSchema)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  import(
    @CurrentActor() actor: Actor,
    @Body(new ZodBody(mapField)) body: z.output<typeof mapField>,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.statements.import(actor, file, body.map);
  }

  @RequirePermission('repayment.approve_payment')
  @Get(':id/rows')
  @ZodResponse(z.array(bankStatementRowSchema))
  rows(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(bankStatementRowsQuerySchema))
    query: z.output<typeof bankStatementRowsQuerySchema>,
  ) {
    return this.statements.rows(id, query.kind);
  }

  @RequirePermission('repayment.approve_payment')
  @Post('rows/:id/review')
  @ZodResponse(bankStatementRowSchema)
  review(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(reviewBankRowSchema)) body: z.output<typeof reviewBankRowSchema>,
  ) {
    return this.statements.review(actor, id, body.note);
  }
}
