import { Global, Module } from '@nestjs/common';
import { CONFIG_GUARDS } from '../../common/config/config-guards.port';
import { CONFIG } from '../../common/config/config.port';
import { ADMIN_NOTICES } from '../../common/config/admin-notices.port';
import { HOLIDAY_CALENDAR } from '../../common/config/holiday-calendar.port';
import { AdminNoticeService } from './admin-notice.service';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';
import { CityController, CityService } from './city.controller';
import { AdminNoticeController, HolidayController } from './holiday.controller';
import { HolidayService } from './holiday.service';

/**
 * Versioned configuration (task 0-6, ADR-006) and the holiday calendar (task 2-1,
 * ADR-021). Global: every module reads configuration through the CONFIG port and working
 * days through HOLIDAY_CALENDAR, never from the tables. A module adds checks of its own to
 * the values of a key it owns through CONFIG_GUARDS. The daily HolidayCoverageCheck
 * runs in the worker.
 */
@Global()
@Module({
  controllers: [ConfigController, HolidayController, AdminNoticeController, CityController],
  providers: [
    CityService,
    ConfigService,
    { provide: CONFIG, useExisting: ConfigService },
    { provide: CONFIG_GUARDS, useExisting: ConfigService },
    HolidayService,
    { provide: HOLIDAY_CALENDAR, useExisting: HolidayService },
    AdminNoticeService,
    { provide: ADMIN_NOTICES, useExisting: AdminNoticeService },
  ],
  // HolidayService: for the holiday batches (plan 3), added in their own transaction.
  exports: [CONFIG, CONFIG_GUARDS, HOLIDAY_CALENDAR, ADMIN_NOTICES, HolidayService],
})
export class ConfigModule {}
