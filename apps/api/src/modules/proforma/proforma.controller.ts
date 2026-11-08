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
  createProformaSchema,
  deviationQueueQuerySchema,
  discardProformaSchema,
  disputeProformaSchema,
  proformaListQuerySchema,
  proformaListSchema,
  proformaViewSchema,
  reviewDeviationSchema,
  reviseProformaSchema,
} from '@sepehr/contracts';
// The named import, as in the other controllers: with the namespace one, the test build's
// decorator metadata takes zod's runtime `output` as a parameter type (OpenAPI drift).
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
import { ProformaService } from './proforma.service';

const doneSchema = z.object({ done: z.literal(true) });

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

/**
 * Proformas for staff (task 3-4): the doctor (or their delegated secretary) issues and
 * corrects; whoever's scope covers the workplace reads; the network reviews prices
 * outside the tariff. Each route has exactly one permission; the service checks scope.
 */
@Controller('proformas')
export class ProformaController {
  constructor(private readonly proformas: ProformaService) {}

  @RequirePermission('proforma.issue')
  @Post()
  @ZodResponse(proformaViewSchema)
  create(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createProformaSchema)) body: z.output<typeof createProformaSchema>,
  ) {
    return this.proformas.create(actor, access, body);
  }

  /** Declared before `:id`, so the path is not read as an id. */
  @RequirePermission('proforma.review_deviations')
  @Get('deviations')
  @ZodResponse(proformaListSchema)
  deviations(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(deviationQueueQuerySchema))
    query: z.output<typeof deviationQueueQuerySchema>,
  ) {
    return this.proformas.deviationQueue(access, query);
  }

  @RequirePermission('proforma.read')
  @Get('workplaces/:id')
  @ZodResponse(proformaListSchema)
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(proformaListQuerySchema)) query: z.output<typeof proformaListQuerySchema>,
  ) {
    return this.proformas.listForWorkplace(access, id, query);
  }

  @RequirePermission('proforma.read')
  @Get(':id')
  @ZodResponse(proformaViewSchema)
  one(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.proformas.get(access, id);
  }

  @RequirePermission('proforma.issue')
  @Post(':id/issue')
  @ZodResponse(proformaViewSchema)
  issue(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.proformas.issue(actor, access, id);
  }

  @RequirePermission('proforma.issue')
  @Post(':id/revise')
  @ZodResponse(proformaViewSchema)
  revise(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(reviseProformaSchema)) body: z.output<typeof reviseProformaSchema>,
  ) {
    return this.proformas.revise(actor, access, id, body);
  }

  @RequirePermission('proforma.issue')
  @Post(':id/discard')
  @ZodResponse(doneSchema)
  async discard(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(discardProformaSchema)) body: z.output<typeof discardProformaSchema>,
  ) {
    await this.proformas.discard(actor, access, id, body.reason);
    return { done: true as const };
  }

  @RequirePermission('proforma.review_deviations')
  @Post(':id/deviation-review')
  @ZodResponse(doneSchema)
  async review(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(reviewDeviationSchema)) body: z.output<typeof reviewDeviationSchema>,
  ) {
    await this.proformas.reviewDeviation(actor, access, id, body.note);
    return { done: true as const };
  }
}

/** A patient's own proformas (self-service; the service checks each is theirs, rule 13). */
@Controller('me/proformas')
export class PatientProformaController {
  constructor(private readonly proformas: ProformaService) {}

  @SelfService()
  @Get()
  @ZodResponse(z.array(proformaViewSchema))
  mine(@CurrentAuth() auth: AuthContext) {
    return this.proformas.listMine(patientOnly(auth));
  }

  @SelfService()
  @Get(':id')
  @ZodResponse(proformaViewSchema)
  one(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.proformas.getMine(patientOnly(auth), id);
  }

  @SelfService()
  @Post(':id/confirm')
  @ZodResponse(proformaViewSchema)
  confirm(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.proformas.confirm(actor, patientOnly(auth), id);
  }

  @SelfService()
  @Post(':id/dispute')
  @ZodResponse(proformaViewSchema)
  dispute(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(disputeProformaSchema)) body: z.output<typeof disputeProformaSchema>,
  ) {
    return this.proformas.dispute(actor, patientOnly(auth), id, body.note);
  }
}
