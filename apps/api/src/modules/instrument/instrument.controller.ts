import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  createDeliverySchema,
  deliveryArchiveSchema,
  deliveryItemSchema,
  deliveryReceivedSchema,
  deliveryReturnSchema,
  deliverySentSchema,
  deliveryViewSchema,
  instrumentNumberViewSchema,
  instrumentSearchQuerySchema,
  instrumentViewSchema,
  myDeliveryViewSchema,
  myInstrumentSchema,
  registerInstrumentSchema,
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
import { InstrumentService } from './instrument.service';

const byApplicationSchema = z.object({ creditApplicationId: z.uuid() });

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

/** Physical deliveries for case completion (task 4-2, doc 12 §3). */
@Controller('deliveries')
export class DeliveryController {
  constructor(private readonly service: InstrumentService) {}

  @RequirePermission('instrument.manage')
  @Post()
  @ZodResponse(deliveryViewSchema)
  create(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createDeliverySchema)) body: z.output<typeof createDeliverySchema>,
  ) {
    return this.service.createDelivery(actor, access, body);
  }

  @RequirePermission('instrument.read')
  @Get()
  @ZodResponse(z.array(deliveryViewSchema))
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(byApplicationSchema)) query: z.output<typeof byApplicationSchema>,
  ) {
    return this.service.deliveries(access, query.creditApplicationId);
  }

  /** Owner 1405/07/27: what the delivery form offers (promissory notes, off by default). */
  @RequirePermission('instrument.manage')
  @Get('options')
  @ZodResponse(z.object({ promissoryNotesEnabled: z.boolean() }))
  options(@CurrentAccess() access: EffectiveAccess) {
    return this.service.options(access);
  }

  @RequirePermission('instrument.read')
  @Get(':id')
  @ZodResponse(deliveryViewSchema)
  one(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.delivery(access, id);
  }

  @RequirePermission('instrument.manage')
  @Post(':id/receive')
  @ZodResponse(deliveryViewSchema)
  receive(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(deliveryReceivedSchema)) body: z.output<typeof deliveryReceivedSchema>,
  ) {
    return this.service.receive(actor, access, id, body);
  }

  @RequirePermission('instrument.manage')
  @Post(':id/items/:itemId')
  @ZodResponse(deliveryViewSchema)
  item(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body(new ZodBody(deliveryItemSchema)) body: z.output<typeof deliveryItemSchema>,
  ) {
    return this.service.markItem(actor, access, id, itemId, body.status);
  }

  @RequirePermission('instrument.manage')
  @Post(':id/instruments')
  @ZodResponse(instrumentViewSchema)
  register(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(registerInstrumentSchema)) body: z.output<typeof registerInstrumentSchema>,
  ) {
    return this.service.register(actor, access, id, body);
  }

  @RequirePermission('instrument.manage')
  @Post(':id/check')
  @ZodResponse(deliveryViewSchema)
  check(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.check(actor, access, id);
  }

  @RequirePermission('instrument.manage')
  @Post(':id/return')
  @ZodResponse(deliveryViewSchema)
  giveBack(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(deliveryReturnSchema)) body: z.output<typeof deliveryReturnSchema>,
  ) {
    return this.service.returnDelivery(actor, access, id, body.reason);
  }

  @RequirePermission('instrument.manage')
  @Post(':id/archive')
  @ZodResponse(deliveryViewSchema)
  archive(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(deliveryArchiveSchema)) body: z.output<typeof deliveryArchiveSchema>,
  ) {
    return this.service.archive(actor, access, id, body.location);
  }
}

/** Cheques and notes (task 4-2): shown by their last four digits only (rule 27). */
@Controller('instruments')
export class InstrumentController {
  constructor(private readonly service: InstrumentService) {}

  /** Found by number through the blind index. Declared before `:id`. */
  @RequirePermission('instrument.read')
  @Get()
  @ZodResponse(z.array(instrumentViewSchema))
  search(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(instrumentSearchQuerySchema))
    query: z.output<typeof instrumentSearchQuerySchema>,
  ) {
    return this.service.search(access, query.number);
  }

  @RequirePermission('instrument.view_numbers')
  @Get(':id/number')
  @ZodResponse(instrumentNumberViewSchema)
  number(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.number(actor, access, id);
  }

  @RequirePermission('instrument.manage')
  @Post(':id/sayad')
  @ZodResponse(instrumentViewSchema)
  sayad(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.confirmSayad(actor, access, id);
  }

  @RequirePermission('instrument.manage')
  @Post(':id/verify')
  @ZodResponse(instrumentViewSchema)
  verify(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.verify(actor, access, id);
  }
}

/** The owner's instruments and their state (task 6-9): the last four characters only. */
@Controller('me/instruments')
export class MyInstrumentController {
  constructor(private readonly service: InstrumentService) {}

  @SelfService()
  @Get()
  @ZodResponse(z.array(myInstrumentSchema))
  mine(@CurrentAuth() auth: AuthContext) {
    return this.service.myInstruments(patientOnly(auth));
  }
}

/** The owner's deliveries: what is expected, and saying how it was sent. */
@Controller('me/deliveries')
export class MyDeliveryController {
  constructor(private readonly service: InstrumentService) {}

  @SelfService()
  @Get()
  @ZodResponse(z.array(myDeliveryViewSchema))
  mine(@CurrentAuth() auth: AuthContext) {
    return this.service.mine(patientOnly(auth));
  }

  @SelfService()
  @Post(':id/sent')
  @ZodResponse(myDeliveryViewSchema)
  sent(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(deliverySentSchema)) body: z.output<typeof deliverySentSchema>,
  ) {
    return this.service.markSent(actor, patientOnly(auth), id, body);
  }
}
