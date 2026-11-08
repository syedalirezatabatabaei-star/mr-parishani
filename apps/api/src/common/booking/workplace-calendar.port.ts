import type { replaceScheduleSchema } from '@sepehr/contracts';
import type { z } from 'zod';
import type { Actor } from '../audit/audit.port';
import type { EffectiveAccess } from '../auth/access.port';

/**
 * Port to the doctors' calendars of the booking module (task 2-9): the bulk import sets a
 * weekly schedule exactly as the panel does, with the same checks (permissions, scope,
 * overlaps with the doctor's other workplaces) and the same audit trail. The booking module
 * provides it under {@link WORKPLACE_CALENDAR}.
 */
export interface WorkplaceCalendar {
  replaceSchedule(
    actor: Actor,
    access: EffectiveAccess,
    workplaceId: string,
    input: z.output<typeof replaceScheduleSchema>,
  ): Promise<unknown>;
}

export const WORKPLACE_CALENDAR = Symbol('WORKPLACE_CALENDAR');
