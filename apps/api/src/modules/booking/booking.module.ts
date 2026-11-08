import { Global, Module } from '@nestjs/common';
import { BOOKABLE_SLOTS } from '../../common/booking/bookable-slots.port';
import { WORKPLACE_CALENDAR } from '../../common/booking/workplace-calendar.port';
import { REFERRAL_DIRECTORY } from '../../common/booking/referral-directory.port';
import { BOOKING_PATIENTS } from '../../common/booking/booking-patients.port';
import { AppointmentPatients } from './booking-patients';
import {
  AdvisorAppointmentController,
  CenterAppointmentController,
  PatientAppointmentController,
} from './appointment.controller';
import { AppointmentService } from './appointment.service';
import { AvailabilityService } from './availability.service';
import { AppointmentBusyTime, BUSY_TIME } from './busy-time';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { ReferralService } from './referral.service';
import { AppointmentTicketLink } from './ticket-link';

/**
 * Booking (doc 08 §6–8). Task 2-5: doctors' calendars at each workplace and the slots
 * computed from them (ADR-025). Task 2-6: appointments and their referrals (ADR-027).
 * Reads workplaces through the catalog's WORKPLACE_DIRECTORY, prices through TARIFF_BOOK,
 * holidays through HOLIDAY_CALENDAR, accounts through ACCOUNT_DIRECTORY, persons and cases
 * through the lead module's LEAD_CASES and configuration through CONFIG, never their
 * tables. The worker runs the scheduler (AppointmentSweeper) and the SMS consumer
 * (AppointmentNotifier) of this module (WorkerModule). Global: the catalog's public search
 * (task 2-7) asks BOOKABLE_SLOTS for the earliest free times; the bulk import (task 2-9)
 * sets schedules through WORKPLACE_CALENDAR.
 */
@Global()
@Module({
  controllers: [
    CalendarController,
    PatientAppointmentController,
    AdvisorAppointmentController,
    CenterAppointmentController,
  ],
  providers: [
    CalendarService,
    AvailabilityService,
    AppointmentService,
    ReferralService,
    { provide: REFERRAL_DIRECTORY, useExisting: ReferralService },
    // A bulk SMS's filter (task 6-5): the patients of some workplaces, read only.
    { provide: BOOKING_PATIENTS, useClass: AppointmentPatients },
    { provide: BUSY_TIME, useClass: AppointmentBusyTime },
    { provide: BOOKABLE_SLOTS, useExisting: AvailabilityService },
    { provide: WORKPLACE_CALENDAR, useExisting: CalendarService },
    // A ticket's link to an appointment (task 7-1), read only.
    AppointmentTicketLink,
  ],
  exports: [BOOKABLE_SLOTS, WORKPLACE_CALENDAR, REFERRAL_DIRECTORY, BOOKING_PATIENTS],
})
export class BookingModule {}
