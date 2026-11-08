import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  exportPayoutsSchema,
  payoutExportSchema,
  payoutQuerySchema,
  payoutReasonSchema,
  payoutViewSchema,
  recordTrackingSchema,
  statementViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  RequireAnyPermission,
  RequirePermission,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { PayoutService } from './payout.service';

/**
 * A statement reviewed and approved, and its payout orders paid (task 5-5): every step that
 * moves money is two people; the service checks who did the first step.
 */
@Controller('settlement')
export class PayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @RequirePermission('settlement.review_statement')
  @Post('statements/:id/review')
  @ZodResponse(statementViewSchema)
  review(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.payouts.review(actor, access, id);
  }

  @RequirePermission('settlement.review_statement')
  @Post('statements/:id/approve')
  @ZodResponse(statementViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.payouts.approve(actor, access, id);
  }

  @RequireAnyPermission('settlement.review_statement', 'settlement.export_payouts')
  @Get('payouts')
  @ZodResponse(z.array(payoutViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(payoutQuerySchema)) query: z.output<typeof payoutQuerySchema>,
  ) {
    return this.payouts.list(actor, access, query);
  }

  @RequirePermission('settlement.export_payouts')
  @Post('payouts/export')
  @ZodResponse(payoutExportSchema)
  export(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(exportPayoutsSchema)) body: z.output<typeof exportPayoutsSchema>,
  ) {
    return this.payouts.export(actor, access, body.payoutIds);
  }

  @RequirePermission('settlement.export_payouts')
  @Get('payouts/exports/:batchId')
  @ZodResponse(payoutExportSchema)
  exported(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ) {
    return this.payouts.exported(actor, access, batchId);
  }

  @RequirePermission('settlement.review_statement')
  @Post('payouts/:id/tracking')
  @ZodResponse(payoutViewSchema)
  tracking(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(recordTrackingSchema)) body: z.output<typeof recordTrackingSchema>,
  ) {
    return this.payouts.recordTracking(actor, access, id, body);
  }

  @RequirePermission('settlement.review_statement')
  @Post('payouts/:id/confirm')
  @ZodResponse(payoutViewSchema)
  confirm(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.payouts.confirm(actor, access, id);
  }

  @RequirePermission('settlement.review_statement')
  @Post('payouts/:id/fail')
  @ZodResponse(payoutViewSchema)
  fail(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(payoutReasonSchema)) body: z.output<typeof payoutReasonSchema>,
  ) {
    return this.payouts.fail(actor, access, id, body.reason);
  }

  @RequirePermission('settlement.review_statement')
  @Post('payouts/:id/reissue')
  @ZodResponse(payoutViewSchema)
  reissue(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.payouts.reissue(actor, access, id);
  }
}
