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
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  BULK_IMPORT_LIMITS,
  bulkImportDecisionSchema,
  proposedTariffListSchema,
  proposedTariffResultSchema,
  bulkImportListQuerySchema,
  bulkImportListSchema,
  bulkPreviewSchema,
} from '@sepehr/contracts';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { BulkImportService, type UploadedWorkbook } from './bulk-import.service';

type Decision = z.output<typeof bulkImportDecisionSchema>;

/**
 * The bulk import of centers and doctors (task 2-9, doc 08 §12), behind
 * `catalog.bulk_import_enabled`; the service checks the permission and the batch's owner.
 */
@Controller('catalog/imports')
export class BulkImportController {
  constructor(private readonly imports: BulkImportService) {}

  @RequirePermission('catalog.import_centers')
  @Get('template')
  @Header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @Header('content-disposition', 'attachment; filename="centers-import.xlsx"')
  template(@CurrentAccess() access: EffectiveAccess) {
    return new StreamableFile(this.imports.template(access));
  }

  /** The caller's own batches, filtered and paged (task 2-11). */
  @RequirePermission('catalog.import_centers')
  @Get()
  @ZodResponse(bulkImportListSchema)
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(bulkImportListQuerySchema))
    query: z.output<typeof bulkImportListQuerySchema>,
  ) {
    return this.imports.list(access, query);
  }

  /** In memory only (never written to disk), within the size limit, scanned first. */
  @RequirePermission('catalog.import_centers')
  @Post()
  @ZodResponse(bulkPreviewSchema)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: BULK_IMPORT_LIMITS.maxFileBytes, files: 1 } }),
  )
  upload(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @UploadedFile() file: UploadedWorkbook | undefined,
  ) {
    return this.imports.upload(actor, access, file);
  }

  @RequirePermission('catalog.import_centers')
  @Get(':id')
  @ZodResponse(bulkPreviewSchema)
  get(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.imports.get(access, id);
  }

  @RequirePermission('catalog.import_centers')
  @Post(':id/commit')
  @ZodResponse(bulkPreviewSchema)
  @HttpCode(HttpStatus.OK)
  commit(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(bulkImportDecisionSchema)) body: Decision,
  ) {
    return this.imports.commit(actor, access, id, body.reason);
  }

  @RequirePermission('catalog.import_centers')
  @Post(':id/cancel')
  @ZodResponse(bulkPreviewSchema)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(bulkImportDecisionSchema)) body: Decision,
  ) {
    return this.imports.cancel(actor, access, id, body.reason);
  }

  @RequirePermission('catalog.import_centers')
  @Get(':id/report.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="centers-import-report.csv"')
  report(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.imports.report(access, id);
  }
}

/**
 * Prices an import proposed for a center (task 2-9 decision 2): whoever may set that
 * center's prices sees and applies them, each as their own price change.
 */
@Controller('catalog/centers')
export class ProposedTariffController {
  constructor(private readonly imports: BulkImportService) {}

  @RequirePermission('catalog.manage_tariffs')
  @Get(':id/proposed-tariffs')
  @ZodResponse(proposedTariffListSchema)
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.imports.proposedTariffs(actor, access, id);
  }

  @RequirePermission('catalog.manage_tariffs')
  @Post(':id/proposed-tariffs/apply')
  @ZodResponse(proposedTariffResultSchema)
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(bulkImportDecisionSchema)) body: Decision,
  ) {
    return this.imports.applyProposed(actor, access, id, body.reason);
  }
}
