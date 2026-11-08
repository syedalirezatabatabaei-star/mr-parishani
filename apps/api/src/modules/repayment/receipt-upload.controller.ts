import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  myPaymentSchema,
  myScheduleSchema,
  mySchedulesQuerySchema,
  uploadRepaymentReceiptSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAuth, SelfService, type AuthContext } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { ReceiptUploadService } from './receipt-upload.service';

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

/** A borrower's payment slip (task 6-2): in memory only, scanned before it is kept. */
@Controller('me/repayment')
export class ReceiptUploadController {
  constructor(private readonly receipts: ReceiptUploadService) {}

  /** Task 6-9: the schedule of one of the patient's own loans, by its application. */
  @SelfService()
  @Get('schedules')
  @ZodResponse(z.array(myScheduleSchema))
  schedules(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodBody(mySchedulesQuerySchema)) query: z.output<typeof mySchedulesQuerySchema>,
  ) {
    if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    return this.receipts.mySchedules(auth.accountId, query.creditApplicationId);
  }

  /** Task 6-9: the slips and payments of the patient's own schedule. */
  @SelfService()
  @Get('schedules/:id/payments')
  @ZodResponse(z.array(myPaymentSchema))
  payments(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    return this.receipts.myPayments(auth.accountId, id);
  }

  @SelfService()
  @Post('receipts')
  @ZodResponse(z.object({ paymentId: z.uuid(), suspectedDuplicate: z.boolean() }))
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  upload(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodBody(uploadRepaymentReceiptSchema))
    body: z.output<typeof uploadRepaymentReceiptSchema>,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    // Rule 5: a client resending the same slip records it once.
    const idempotencyKey = `receipt:${key ?? `${body.scheduleId}:${body.bankRef}:${body.amountRial.toString()}:${body.paidOn}`}`;
    return this.receipts.upload(actor, auth.accountId, body, file, idempotencyKey);
  }
}
