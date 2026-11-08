import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type { BookingPatient, BookingPatients } from '../../common/booking/booking-patients.port';
import { DATABASE, type Database } from '../../db/database.module';

/** BOOKING_PATIENTS (task 6-5): who came, or was confirmed to come, to these workplaces. */
@Injectable()
export class AppointmentPatients implements BookingPatients {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async patientsAt(
    workplaceIds: readonly string[],
    range: { from: Date | null; to: Date | null },
    tx?: SqlExecutor,
  ): Promise<BookingPatient[]> {
    if (workplaceIds.length === 0) return [];
    const rows = await (tx ?? this.db).execute(sql`
      SELECT DISTINCT ON (mobile) person_id, mobile
      FROM appointments
      WHERE workplace_id IN (${sql.join(
        workplaceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND status IN ('confirmed', 'checked_in', 'examined')
        AND (${range.from}::timestamptz IS NULL OR starts_at >= ${range.from})
        AND (${range.to}::timestamptz IS NULL OR starts_at < ${range.to})
      ORDER BY mobile, starts_at DESC, id DESC
    `);
    return rows.rows.map((r) => ({
      personId: (r['person_id'] as string | null) ?? null,
      mobile: r['mobile'] as string,
    }));
  }

  async patientAccountOf(appointmentId: string, tx?: SqlExecutor): Promise<string | null> {
    const rows = await (tx ?? this.db).execute(sql`
      SELECT patient_account_id FROM appointments WHERE id = ${appointmentId}
    `);
    return (rows.rows[0]?.['patient_account_id'] as string | null | undefined) ?? null;
  }
}
