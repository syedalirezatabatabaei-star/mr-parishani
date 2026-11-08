import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  cancelTariffVersionSchema,
  createServiceSchema,
  createTreatmentFieldSchema,
  retireCatalogItemSchema,
  setTariffSchema,
  tariffListQuerySchema,
  tariffQuoteQuerySchema,
  updateServiceSchema,
  updateTreatmentFieldSchema,
  withdrawTariffSchema,
  serviceListSchema,
  treatmentFieldListSchema,
  tariffListSchema,
  catalogItemRetiredSchema,
  serviceViewSchema,
  tariffDetailSchema,
  tariffQuoteViewSchema,
  treatmentFieldViewSchema,
  tariffViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, Public, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { CatalogItemService } from './catalog-item.service';
import { TariffService } from './tariff.service';

const serviceQuerySchema = z.object({
  fieldCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,62}$/)
    .optional(),
});

/**
 * Treatment fields and services (task 2-4). Listing is public: booking and profile pages
 * show them. Changing them needs catalog.manage_catalog, which the service checks again
 * (rule 12).
 */
@Controller('catalog')
export class CatalogItemController {
  constructor(private readonly items: CatalogItemService) {}

  @Public()
  @Get('fields')
  @ZodResponse(treatmentFieldListSchema)
  listFields() {
    return this.items.listFields();
  }

  @Public()
  @Get('services')
  @ZodResponse(serviceListSchema)
  listServices(@Query(new ZodBody(serviceQuerySchema)) query: z.output<typeof serviceQuerySchema>) {
    return this.items.listServices(query.fieldCode);
  }

  @RequirePermission('catalog.manage_catalog')
  @Post('fields')
  @ZodResponse(treatmentFieldViewSchema)
  createField(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createTreatmentFieldSchema))
    body: z.output<typeof createTreatmentFieldSchema>,
  ) {
    return this.items.createField(actor, access, body);
  }

  @RequirePermission('catalog.manage_catalog')
  @Patch('fields/:code')
  @ZodResponse(treatmentFieldViewSchema)
  updateField(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code') code: string,
    @Body(new ZodBody(updateTreatmentFieldSchema))
    body: z.output<typeof updateTreatmentFieldSchema>,
  ) {
    return this.items.updateField(actor, access, code, body);
  }

  @RequirePermission('catalog.manage_catalog')
  @Post('fields/:code/retire')
  @ZodResponse(catalogItemRetiredSchema)
  async retireField(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code') code: string,
    @Body(new ZodBody(retireCatalogItemSchema)) body: z.output<typeof retireCatalogItemSchema>,
  ) {
    await this.items.retireField(actor, access, code, body.reason);
    return { retired: true };
  }

  @RequirePermission('catalog.manage_catalog')
  @Post('services')
  @ZodResponse(serviceViewSchema)
  createService(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createServiceSchema)) body: z.output<typeof createServiceSchema>,
  ) {
    return this.items.createService(actor, access, body);
  }

  @RequirePermission('catalog.manage_catalog')
  @Patch('services/:code')
  @ZodResponse(serviceViewSchema)
  updateService(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code') code: string,
    @Body(new ZodBody(updateServiceSchema)) body: z.output<typeof updateServiceSchema>,
  ) {
    return this.items.updateService(actor, access, code, body);
  }

  @RequirePermission('catalog.manage_catalog')
  @Post('services/:code/retire')
  @ZodResponse(catalogItemRetiredSchema)
  async retireService(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code') code: string,
    @Body(new ZodBody(retireCatalogItemSchema)) body: z.output<typeof retireCatalogItemSchema>,
  ) {
    await this.items.retireService(actor, access, code, body.reason);
    return { retired: true };
  }
}

/**
 * Tariffs (task 2-4). The guard checks the endpoint's permission; the service checks it
 * again with the owner and who is asking (rules 12 and 13).
 */
@Controller('catalog')
export class TariffController {
  constructor(private readonly tariffs: TariffService) {}

  @RequirePermission('catalog.manage_tariffs')
  @Post('tariffs')
  @ZodResponse(tariffViewSchema)
  set(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(setTariffSchema)) body: z.output<typeof setTariffSchema>,
  ) {
    return this.tariffs.set(actor, access, body);
  }

  @RequirePermission('catalog.read_tariffs')
  @Get('tariffs')
  @ZodResponse(tariffListSchema)
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(tariffListQuerySchema)) query: z.output<typeof tariffListQuerySchema>,
  ) {
    return this.tariffs.list(actor, access, query);
  }

  @RequirePermission('catalog.read_tariffs')
  @Get('tariffs/:id')
  @ZodResponse(tariffDetailSchema)
  get(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tariffs.get(actor, access, id);
  }

  @RequirePermission('catalog.manage_tariffs')
  @Post('tariffs/:id/withdraw')
  @ZodResponse(tariffViewSchema)
  withdraw(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(withdrawTariffSchema)) body: z.output<typeof withdrawTariffSchema>,
  ) {
    return this.tariffs.withdraw(actor, access, id, body);
  }

  @RequirePermission('catalog.manage_tariffs')
  @Post('tariff-versions/:id/cancel')
  @ZodResponse(tariffViewSchema)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(cancelTariffVersionSchema)) body: z.output<typeof cancelTariffVersionSchema>,
  ) {
    return this.tariffs.cancel(actor, access, id, body.reason);
  }

  /*
   * The network specialist's path (task 2-4 decision): a private practice whose doctor has
   * no account, until the doctor gets one. Separate endpoints, so each declares exactly its
   * own permission; the reason is required as everywhere, and the change is audited on the
   * doctor's behalf.
   */

  @RequirePermission('catalog.manage_tariff_for_unaccounted_doctor')
  @Post('network/tariffs')
  @ZodResponse(tariffViewSchema)
  setForUnaccountedDoctor(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(setTariffSchema)) body: z.output<typeof setTariffSchema>,
  ) {
    return this.tariffs.set(actor, access, body, 'network');
  }

  @RequirePermission('catalog.manage_tariff_for_unaccounted_doctor')
  @Post('network/tariffs/:id/withdraw')
  @ZodResponse(tariffViewSchema)
  withdrawForUnaccountedDoctor(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(withdrawTariffSchema)) body: z.output<typeof withdrawTariffSchema>,
  ) {
    return this.tariffs.withdraw(actor, access, id, body, 'network');
  }

  @RequirePermission('catalog.manage_tariff_for_unaccounted_doctor')
  @Post('network/tariff-versions/:id/cancel')
  @ZodResponse(tariffViewSchema)
  cancelForUnaccountedDoctor(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(cancelTariffVersionSchema)) body: z.output<typeof cancelTariffVersionSchema>,
  ) {
    return this.tariffs.cancel(actor, access, id, body.reason, 'network');
  }

  /** The price booking would get for a service at this workplace (null if not offered). */
  @RequirePermission('catalog.read_tariffs')
  @Get('workplaces/:id/quote')
  @ZodResponse(tariffQuoteViewSchema)
  async quote(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(tariffQuoteQuerySchema)) query: z.output<typeof tariffQuoteQuerySchema>,
  ) {
    return { quote: await this.tariffs.quoteFor(actor, access, id, query) };
  }
}
