/**
 * Port to the free times of the booking module (task 2-7): what the public search may know
 * about a workplace's slots without reading booking's tables. The booking module provides
 * it under {@link BOOKABLE_SLOTS}.
 *
 * Only times and services come back: never why a time is taken, nor that it is taken at the
 * doctor's other workplace (task 2-5 decision 4, task 2-7 decision 4).
 */
export interface UpcomingSlot {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly serviceCodes: readonly string[];
}

export interface UpcomingSlotsOptions {
  /** At most this many, the earliest first. */
  readonly limit: number;
  readonly now?: Date;
  /** Only slots that offer this service. */
  readonly serviceCode?: string;
}

export interface BookableSlots {
  /**
   * The earliest free slots of a workplace from now to the booking horizon, computed now
   * exactly as a patient would see them. Empty when the workplace is unknown or takes no new
   * appointments (its center is not active).
   */
  upcoming(workplaceId: string, options: UpcomingSlotsOptions): Promise<UpcomingSlot[]>;
}

export const BOOKABLE_SLOTS = Symbol('BOOKABLE_SLOTS');
