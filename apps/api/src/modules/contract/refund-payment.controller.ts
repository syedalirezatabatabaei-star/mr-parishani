import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  decideRefundPaymentSchema,
  refundOwedSchema,
  refundPaymentQuerySchema,
  refundPaymentViewSchema,
  requestRefundPaymentSchema,
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
import { RefundPaymentService } from './refund-payment.service';

/** Refunds paid out by bank (task 4-8, ADR-036): recorded by one, approved by another. */
@Controller('refund-payments')
export class RefundPaymentController {
  constructor(private readonly payments: RefundPaymentService) {}

  @RequirePermission('contract.request_refund_payment')
  @Post()
  @ZodResponse(refundPaymentViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(requestRefundPaymentSchema))
    body: z.output<typeof requestRefundPaymentSchema>,
  ) {
    return this.payments.request(actor, access, body);
  }

  @RequireAnyPermission('contract.request_refund_payment', 'contract.approve_refund_payment')
  @Get()
  @ZodResponse(z.array(refundPaymentViewSchema))
  list(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(refundPaymentQuerySchema))
    query: z.output<typeof refundPaymentQuerySchema>,
  ) {
    return this.payments.list(actor, access, query);
  }

  /** What is still owed back to the borrower of an application, by account. */
  @RequireAnyPermission('contract.request_refund_payment', 'contract.approve_refund_payment')
  @Get('owed/:applicationId')
  @ZodResponse(refundOwedSchema)
  owed(
    @CurrentAccess() access: EffectiveAccess,
    @Param('applicationId', new ParseUUIDPipe()) applicationId: string,
  ) {
    return this.payments.owed(access, applicationId);
  }

  @RequirePermission('contract.approve_refund_payment')
  @Post(':id/approve')
  @ZodResponse(refundPaymentViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideRefundPaymentSchema))
    body: z.output<typeof decideRefundPaymentSchema>,
  ) {
    return this.payments.approve(actor, access, id, body.reason);
  }

  @RequirePermission('contract.approve_refund_payment')
  @Post(':id/reject')
  @ZodResponse(refundPaymentViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(decideRefundPaymentSchema))
    body: z.output<typeof decideRefundPaymentSchema>,
  ) {
    return this.payments.reject(actor, access, id, body.reason);
  }
}
