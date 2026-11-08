import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  createExceptionSchema,
  removeExceptionSchema,
  replaceScheduleSchema,
  setApprovalModeSchema,
  slotQuerySchema,
  calendarViewSchema,
  scheduleViewSchema,
  exceptionViewSchema,
  exceptionRemovedSchema,
  approvalModeViewSchema,
  slotViewListSchema,
} from '@sepehr/contracts';
import type { z } from 'zod';
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
import { AvailabilityService } from './availability.service';
import { CalendarService } from './calendar.service';

/**
 * A doctor's calendar at one workplace (task 2-5). The guard checks the endpoint's
 * permission; the service checks which one applies to this workplace and who is asking
 * (rules 12 and 13). A calendar is changed as its own doctor (or delegated secretary), as a
 * manager in scope, or as Sepehr's operator: three permissions, any of which lets the
 * request through to that check.
 */
@Controller('booking')
export class CalendarController {
  constructor(
    private readonly calendars: CalendarService,
    private readonly availability: AvailabilityService,
  ) {}

  @RequirePermission('booking.read_calendar')
  @Get('workplaces/:id/calendar')
  @ZodResponse(calendarViewSchema)
  calendar(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.calendars.calendar(access, id);
  }

  @RequireAnyPermission(
    'booking.manage_own_calendar',
    'booking.manage_calendar_in_scope',
    'booking.manage_any_calendar',
  )
  @Put('workplaces/:id/schedule')
  @ZodResponse(scheduleViewSchema)
  replaceSchedule(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(replaceScheduleSchema)) body: z.output<typeof replaceScheduleSchema>,
  ) {
    return this.calendars.replaceSchedule(actor, access, id, body);
  }

  @RequireAnyPermission(
    'booking.manage_own_calendar',
    'booking.manage_calendar_in_scope',
    'booking.manage_any_calendar',
  )
  @Post('workplaces/:id/exceptions')
  @ZodResponse(exceptionViewSchema)
  addException(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(createExceptionSchema)) body: z.output<typeof createExceptionSchema>,
  ) {
    return this.calendars.addException(actor, access, id, body);
  }

  @RequireAnyPermission(
    'booking.manage_own_calendar',
    'booking.manage_calendar_in_scope',
    'booking.manage_any_calendar',
  )
  @Post('exceptions/:id/remove')
  @ZodResponse(exceptionRemovedSchema)
  async removeException(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(removeExceptionSchema)) body: z.output<typeof removeExceptionSchema>,
  ) {
    await this.calendars.removeException(actor, access, id, body.reason);
    return { removed: true };
  }

  @RequirePermission('booking.manage_approval_mode')
  @Put('workplaces/:id/approval-mode')
  @ZodResponse(approvalModeViewSchema)
  setApprovalMode(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(setApprovalModeSchema)) body: z.output<typeof setApprovalModeSchema>,
  ) {
    return this.calendars.setApprovalMode(actor, access, id, body);
  }

  /** Free slots for the panel; the patients' view comes with the hold of task 2-6. */
  @RequirePermission('booking.read_calendar')
  @Get('workplaces/:id/slots')
  @ZodResponse(slotViewListSchema)
  slots(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(slotQuerySchema)) query: z.output<typeof slotQuerySchema>,
  ) {
    return this.availability.slots(access, id, query);
  }
}
