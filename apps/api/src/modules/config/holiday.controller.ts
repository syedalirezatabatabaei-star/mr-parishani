import { Controller, Get, Query } from '@nestjs/common';
import { adminNoticeListSchema, holidayListSchema, holidayQuerySchema } from '@sepehr/contracts';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentAccess, Public, RequirePermission } from '../../common/auth/auth.decorators';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { HolidayService } from './holiday.service';

/**
 * The holiday calendar (task 2-1). Listing is public: booking pages show holidays to
 * patients (doc 08). Owner 1405/07/27: no single-day path any more; a holiday is saved only
 * by two people, through the batches (ADR-043; HolidayBatchController), a city's too.
 */
@Controller('calendar/holidays')
export class HolidayController {
  constructor(private readonly holidays: HolidayService) {}

  @Public()
  @Get()
  @ZodResponse(holidayListSchema)
  list(@Query(new ZodBody(holidayQuerySchema)) query: z.output<typeof holidayQuerySchema>) {
    return this.holidays.list(query);
  }
}

/**
 * Notices for the panel (task 2-1: e.g. next year's holidays missing). Anyone who reads
 * configuration may ask; each sees only notices addressed to a permission they hold.
 */
@Controller('config/notices')
export class AdminNoticeController {
  constructor(private readonly holidays: HolidayService) {}

  @RequirePermission('config.read')
  @Get()
  @ZodResponse(adminNoticeListSchema)
  list(@CurrentAccess() access: EffectiveAccess) {
    return this.holidays.notices(access);
  }
}
