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
} from '@nestjs/common';
import {
  approvePaymentSchema,
  paymentQueueQuerySchema,
  paymentQueueRowSchema,
  rejectPaymentSchema,
  suspenseRowSchema,
  paymentDecisionSchema,
  installmentScheduleViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import { RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import type { PaymentDecision } from '../../common/repayment/repayment.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { RepaymentService } from './repayment.service';

const decisionView = (d: PaymentDecision) => ({
  paymentId: d.paymentId,
  status: d.status,
  allocatedRial: d.allocatedRial.toString(),
  surplusRial: d.surplusRial.toString(),
  allocations: d.allocations.map((a) => ({
    installmentId: a.installmentId,
    amountRial: a.amountRial.toString(),
  })),
});

/**
 * Installments and payments (task 1-3). Reading: accounting and the auditor. Approving or
 * rejecting a received payment: accounting, one person, audited. Schedules and receipts
 * are created through the REPAYMENT port. Amounts leave as strings of rials.
 */
@Controller('repayment')
export class RepaymentController {
  constructor(private readonly repayment: RepaymentService) {}

  @RequirePermission('repayment.read')
  @Get('schedules/:id')
  @ZodResponse(installmentScheduleViewSchema)
  async schedule(@Param('id', new ParseUUIDPipe()) id: string) {
    const s = await this.repayment.schedule(id);
    return {
      id: s.id,
      caseId: s.caseId,
      purseId: s.purseId,
      principalRial: s.principalRial.toString(),
      planFeeRial: s.planFeeRial.toString(),
      totalRial: s.totalRial.toString(),
      fundedAt: s.fundedAt.toISOString(),
      roundingUnitRial: s.roundingUnitRial.toString(),
      paidRial: s.paidRial.toString(),
      outstandingRial: s.outstandingRial.toString(),
      unallocatedRial: s.unallocatedRial.toString(),
      installments: s.installments.map((i) => ({
        id: i.id,
        index: i.index,
        dueOn: i.dueOn,
        amountRial: i.amountRial.toString(),
        paidRial: i.paidRial.toString(),
        outstandingRial: i.outstandingRial.toString(),
        status: i.status,
      })),
    };
  }

  @RequirePermission('repayment.approve_payment')
  @Post('payments/:id/approve')
  @ZodResponse(paymentDecisionSchema)
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(approvePaymentSchema)) body: z.output<typeof approvePaymentSchema>,
  ) {
    // Task 6-2: a slip flagged as a likely duplicate needs notDuplicate and a reason.
    return decisionView(
      await this.repayment.approvePayment(actor, id, undefined, {
        ...(body.notDuplicate === undefined ? {} : { notDuplicate: body.notDuplicate }),
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      }),
    );
  }

  @RequirePermission('repayment.approve_payment')
  @Post('payments/:id/reject')
  @ZodResponse(paymentDecisionSchema)
  @HttpCode(HttpStatus.OK)
  async reject(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(rejectPaymentSchema)) body: z.output<typeof rejectPaymentSchema>,
  ) {
    // Task 6-2 (owner): the kind decides whether the pending posting is reversed.
    return decisionView(
      await this.repayment.rejectPayment(actor, id, body.reason, undefined, body.kind),
    );
  }

  /** Task 6-2: the approval queue, with the duplicate flag (never the slip's image). */
  @RequirePermission('repayment.approve_payment')
  @Get('payments')
  @ZodResponse(z.array(paymentQueueRowSchema))
  payments(
    @Query(new ZodBody(paymentQueueQuerySchema)) query: z.output<typeof paymentQueueQuerySchema>,
  ) {
    return this.repayment.payments(query.status);
  }

  /** Task 6-2: what is held in suspense, and why (reported, not moved). */
  @RequirePermission('repayment.read')
  @Get('suspense')
  @ZodResponse(z.array(suspenseRowSchema))
  suspense() {
    return this.repayment.suspense();
  }
}
