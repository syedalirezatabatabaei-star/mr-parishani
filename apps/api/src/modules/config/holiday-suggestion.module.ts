import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  createHolidayBatchSchema,
  holidayBatchListSchema,
  holidayBatchViewSchema,
  holidayRemovalListSchema,
  holidayRemovalViewSchema,
  requestHolidayRemovalSchema,
  holidaySuggestionQuerySchema,
  holidaySuggestionsViewSchema,
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
import { HolidayBatchService } from './holiday-batch.service';
import { HolidayRemovalService } from './holiday-removal.service';
import { HolidaySuggestionService } from './holiday-suggestion.service';

/** Plan 3 (ADR-043): the year's suggested official holidays; a preview, nothing saved. */
@Controller('calendar/holidays/suggestions')
export class HolidaySuggestionController {
  constructor(private readonly suggestions: HolidaySuggestionService) {}

  @RequirePermission('config.manage_holidays')
  @Get()
  @ZodResponse(holidaySuggestionsViewSchema)
  suggest(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(holidaySuggestionQuerySchema))
    query: z.output<typeof holidaySuggestionQuerySchema>,
  ) {
    return this.suggestions.forYear(access, query.year);
  }
}

/**
 * Holidays saved together (owner 1405/07/24): asked by one, approved or rejected by a second,
 * all or none; the count of contracts not yet funded on those days shown to both.
 */
@Controller('calendar/holidays/batches')
export class HolidayBatchController {
  constructor(private readonly batches: HolidayBatchService) {}

  @RequirePermission('config.manage_holidays')
  @Post()
  @ZodResponse(holidayBatchViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createHolidayBatchSchema)) body: z.output<typeof createHolidayBatchSchema>,
  ) {
    return this.batches.request(actor, access, body);
  }

  @RequireAnyPermission('config.manage_holidays', 'config.approve_holidays')
  @Get()
  @ZodResponse(holidayBatchListSchema)
  pending(@CurrentAccess() access: EffectiveAccess) {
    return this.batches.pending(access);
  }

  @RequireAnyPermission('config.manage_holidays', 'config.approve_holidays')
  @Post(':id/approve')
  @ZodResponse(holidayBatchViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.batches.approve(actor, access, id);
  }

  @RequireAnyPermission('config.manage_holidays', 'config.approve_holidays')
  @Post(':id/reject')
  @ZodResponse(holidayBatchViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.batches.reject(actor, access, id);
  }
}

/**
 * A holiday taken off the calendar (owner 1405/07/29; migration 0099): asked by one, approved
 * (soft deleted) or rejected by a second; the count of contracts not yet funded on it shown to
 * both.
 */
@Controller('calendar/holidays/removals')
export class HolidayRemovalController {
  constructor(private readonly removals: HolidayRemovalService) {}

  @RequirePermission('config.manage_holidays')
  @Post()
  @ZodResponse(holidayRemovalViewSchema)
  request(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(requestHolidayRemovalSchema))
    body: z.output<typeof requestHolidayRemovalSchema>,
  ) {
    return this.removals.request(actor, access, body);
  }

  @RequireAnyPermission('config.manage_holidays', 'config.approve_holidays')
  @Get()
  @ZodResponse(holidayRemovalListSchema)
  pending(@CurrentAccess() access: EffectiveAccess) {
    return this.removals.pending(access);
  }

  @RequireAnyPermission('config.manage_holidays', 'config.approve_holidays')
  @Post(':id/approve')
  @ZodResponse(holidayRemovalViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.removals.approve(actor, access, id);
  }

  @RequireAnyPermission('config.manage_holidays', 'config.approve_holidays')
  @Post(':id/reject')
  @ZodResponse(holidayRemovalViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.removals.reject(actor, access, id);
  }
}

/**
 * Apart from the global ConfigModule: the preview reads the contract and wallet ports, which
 * the worker and the CLIs that load ConfigModule do not have. The API's AppModule only.
 */
@Module({
  controllers: [HolidaySuggestionController, HolidayBatchController, HolidayRemovalController],
  providers: [HolidaySuggestionService, HolidayBatchService, HolidayRemovalService],
})
export class HolidaySuggestionModule {}
