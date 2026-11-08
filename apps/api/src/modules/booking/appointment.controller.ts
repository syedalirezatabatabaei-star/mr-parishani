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
} from '@nestjs/common';
import {
  advisorHoldSchema,
  appointmentListQuerySchema,
  appointmentReasonSchema,
  checkInSchema,
  holdAppointmentSchema,
  rescheduleAppointmentSchema,
  resolveNoShowDisputeSchema,
  respondAppointmentSchema,
  slotQuerySchema,
  visitPaymentSchema,
  appointmentViewSchema,
  freeSlotListSchema,
  noShowDisputedSchema,
  patientAppointmentPageSchema,
  patientAppointmentQuerySchema,
  workplaceAppointmentListSchema,
  pendingApprovalsSchema,
  noShowDisputeResolvedSchema,
  referralListSchema,
  visitPaymentRecordedSchema,
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
import { AppointmentService } from './appointment.service';
import { AvailabilityService } from './availability.service';
import { ReferralService } from './referral.service';

/** Optional; the same key from the same account returns the first hold (rule 5). */
const idempotencyKeySchema = z.string().min(8).max(200).optional();

const referralQuerySchema = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: 'from must be before to' });

function patientOnly(auth: AuthContext): string {
  if (auth.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
  return auth.accountId;
}

const idempotencyKey = (header: string | undefined) => {
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) throw new ForbiddenException({ error: 'invalid_idempotency_key' });
  return parsed.data ?? null;
};

/**
 * A patient's own appointments (task 2-6): self-service, the service checks that each one
 * is theirs (rule 13). Free slots are open to any logged-in user; they say nothing but
 * which times are free.
 */
@Controller('booking')
export class PatientAppointmentController {
  constructor(
    private readonly appointments: AppointmentService,
    private readonly availability: AvailabilityService,
  ) {}

  @SelfService()
  @Get('workplaces/:id/free-slots')
  @ZodResponse(freeSlotListSchema)
  freeSlots(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(slotQuerySchema)) query: z.output<typeof slotQuerySchema>,
  ) {
    return this.availability.bookableSlots(id, query);
  }

  @SelfService()
  @Post('appointments/hold')
  @ZodResponse(appointmentViewSchema)
  hold(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodBody(holdAppointmentSchema)) body: z.output<typeof holdAppointmentSchema>,
  ) {
    return this.appointments.hold(
      actor,
      { kind: 'patient', accountId: patientOnly(auth), client: auth.client },
      body,
      idempotencyKey(key),
    );
  }

  @SelfService()
  @Post('appointments/:id/request')
  @ZodResponse(appointmentViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.appointments.submit(actor, { kind: 'patient', accountId: patientOnly(auth) }, id);
  }

  @SelfService()
  @Get('me/appointments')
  @ZodResponse(patientAppointmentPageSchema)
  mine(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodBody(patientAppointmentQuerySchema))
    query: z.output<typeof patientAppointmentQuerySchema>,
  ) {
    return this.appointments.listForPatient(patientOnly(auth), query);
  }

  @SelfService()
  @Get('me/appointments/:id')
  @ZodResponse(appointmentViewSchema)
  one(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.appointments.getForPatient(patientOnly(auth), id);
  }

  @SelfService()
  @Post('me/appointments/:id/cancel')
  @ZodResponse(appointmentViewSchema)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(appointmentReasonSchema)) body: z.output<typeof appointmentReasonSchema>,
  ) {
    return this.appointments.cancelByPatient(actor, patientOnly(auth), id, body.reason);
  }

  @SelfService()
  @Post('me/appointments/:id/reschedule')
  @ZodResponse(appointmentViewSchema)
  reschedule(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(rescheduleAppointmentSchema))
    body: z.output<typeof rescheduleAppointmentSchema>,
  ) {
    return this.appointments.reschedule(
      actor,
      { kind: 'patient', accountId: patientOnly(auth) },
      id,
      body,
    );
  }

  @SelfService()
  @Post('me/appointments/:id/dispute-no-show')
  @ZodResponse(noShowDisputedSchema)
  dispute(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(appointmentReasonSchema)) body: z.output<typeof appointmentReasonSchema>,
  ) {
    return this.appointments.disputeNoShow(actor, patientOnly(auth), id, body.reason);
  }
}

/** An advisor booking for a patient, and the appointments of their own cases. */
@Controller('booking/advisor')
export class AdvisorAppointmentController {
  constructor(private readonly appointments: AppointmentService) {}

  @RequirePermission('booking.book_for_patient')
  @Post('appointments/hold')
  @ZodResponse(appointmentViewSchema)
  hold(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodBody(advisorHoldSchema)) body: z.output<typeof advisorHoldSchema>,
  ) {
    return this.appointments.hold(
      actor,
      { kind: 'advisor', accountId: auth.accountId, mobile: body.mobile, name: body.name ?? null },
      body,
      idempotencyKey(key),
    );
  }

  @RequirePermission('booking.book_for_patient')
  @Post('appointments/:id/request')
  @ZodResponse(appointmentViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.appointments.submit(actor, { kind: 'advisor', accountId: auth.accountId }, id);
  }

  @RequirePermission('booking.book_for_patient')
  @Get('cases/:id/appointments')
  @ZodResponse(z.array(appointmentViewSchema))
  ofCase(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.appointments.listForCase(actor, access, id);
  }
}

/**
 * A workplace's appointments for whoever's scope covers it: the doctor, a secretary by
 * delegation, the center or branch, Sepehr's operators (rules 12 and 13).
 */
@Controller('booking')
export class CenterAppointmentController {
  constructor(
    private readonly appointments: AppointmentService,
    private readonly referrals: ReferralService,
  ) {}

  @RequirePermission('booking.read_appointments')
  @Get('workplaces/:id/appointments')
  @ZodResponse(workplaceAppointmentListSchema)
  list(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(appointmentListQuerySchema))
    query: z.output<typeof appointmentListQuerySchema>,
  ) {
    return this.appointments.listForWorkplace(access, id, query);
  }

  /** The panel's warning: requests still waiting for a manual answer (decision 1). */
  @RequirePermission('booking.read_appointments')
  @Get('workplaces/:id/pending-approvals')
  @ZodResponse(pendingApprovalsSchema)
  pending(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.appointments.pendingManual(access, id);
  }

  @RequirePermission('booking.read_appointments')
  @Get('appointments/:id')
  @ZodResponse(appointmentViewSchema)
  one(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.appointments.getForStaff(access, id);
  }

  @RequirePermission('booking.manage_appointments')
  @Post('appointments/:id/respond')
  @ZodResponse(appointmentViewSchema)
  respond(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(respondAppointmentSchema)) body: z.output<typeof respondAppointmentSchema>,
  ) {
    return this.appointments.respond(actor, access, id, body);
  }

  @RequirePermission('booking.manage_appointments')
  @Post('appointments/:id/check-in')
  @ZodResponse(appointmentViewSchema)
  checkIn(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(checkInSchema)) body: z.output<typeof checkInSchema>,
  ) {
    return this.appointments.checkIn(actor, access, id, body.code);
  }

  @RequirePermission('booking.manage_appointments')
  @Post('appointments/:id/examined')
  @ZodResponse(appointmentViewSchema)
  examined(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.appointments.markExamined(actor, access, id);
  }

  @RequirePermission('booking.manage_appointments')
  @Post('appointments/:id/no-show')
  @ZodResponse(appointmentViewSchema)
  noShow(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(appointmentReasonSchema)) body: z.output<typeof appointmentReasonSchema>,
  ) {
    return this.appointments.markNoShow(actor, access, id, body.reason);
  }

  @RequirePermission('booking.manage_appointments')
  @Post('appointments/:id/cancel')
  @ZodResponse(appointmentViewSchema)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(appointmentReasonSchema)) body: z.output<typeof appointmentReasonSchema>,
  ) {
    return this.appointments.cancelByCenter(actor, access, id, body.reason);
  }

  @RequirePermission('booking.manage_appointments')
  @Post('appointments/:id/reschedule')
  @ZodResponse(appointmentViewSchema)
  reschedule(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(rescheduleAppointmentSchema))
    body: z.output<typeof rescheduleAppointmentSchema>,
  ) {
    return this.appointments.reschedule(actor, { kind: 'center', access }, id, body);
  }

  @RequirePermission('booking.manage_appointments')
  @Post('appointments/:id/visit-payment')
  @ZodResponse(visitPaymentRecordedSchema)
  visitPayment(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(visitPaymentSchema)) body: z.output<typeof visitPaymentSchema>,
  ) {
    return this.appointments.recordVisitPayment(actor, access, id, body);
  }

  @RequirePermission('booking.resolve_no_show_dispute')
  @Post('appointments/:id/no-show-dispute/resolve')
  @ZodResponse(noShowDisputeResolvedSchema)
  resolve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(resolveNoShowDisputeSchema))
    body: z.output<typeof resolveNoShowDisputeSchema>,
  ) {
    return this.appointments.resolveNoShowDispute(actor, access, id, body);
  }

  @RequirePermission('booking.read_referrals')
  @Get('referrals')
  @ZodResponse(referralListSchema)
  referralsBetween(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(referralQuerySchema)) query: z.output<typeof referralQuerySchema>,
  ) {
    return this.referrals.list(access, new Date(query.from), new Date(query.to));
  }
}
