import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type {
  ProformaDirectory,
  ProformaLineRecord,
  ProformaRecord,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PROFORMA_DIRECTORY: a proforma for the credit application (task 3-5), read-only. */
@Injectable()
export class ProformaDirectoryService implements ProformaDirectory {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async proforma(proformaId: string, tx?: SqlExecutor): Promise<ProformaRecord | null> {
    if (!UUID.test(proformaId)) return null;
    const result = await (tx ?? this.db).execute(sql`
      SELECT id, case_id, person_id, doctor_id, workplace_id, city_code, version, status,
             total_rial::text AS total_rial, patient_response_note, created_by, issued_by
      FROM proformas WHERE id = ${proformaId}::uuid AND deleted_at IS NULL`);
    const row = result.rows[0];
    if (!row) return null;
    return {
      proformaId: row['id'] as string,
      caseId: row['case_id'] as string,
      personId: row['person_id'] as string,
      doctorId: row['doctor_id'] as string,
      workplaceId: row['workplace_id'] as string,
      cityCode: row['city_code'] as string,
      version: Number(row['version']),
      status: row['status'] as string,
      totalRial: BigInt(row['total_rial'] as string),
      patientResponseNote: (row['patient_response_note'] as string | null) ?? null,
      createdBy: (row['created_by'] as string | null) ?? null,
      issuedBy: (row['issued_by'] as string | null) ?? null,
    };
  }

  async lines(proformaId: string, tx?: SqlExecutor): Promise<ProformaLineRecord[]> {
    if (!UUID.test(proformaId)) return [];
    const result = await (tx ?? this.db).execute(sql`
      SELECT l.id, l.line_no, l.service_code, l.quantity, l.line_total_rial::text AS total,
             l.cost_kind
      FROM proforma_lines l JOIN proformas p ON p.id = l.proforma_id
      WHERE l.proforma_id = ${proformaId}::uuid AND p.deleted_at IS NULL
      ORDER BY l.line_no`);
    return result.rows.map((row) => ({
      id: row['id'] as string,
      lineNo: Number(row['line_no']),
      serviceCode: row['service_code'] as string,
      quantity: Number(row['quantity']),
      lineTotalRial: BigInt(row['total'] as string),
      costKind: row['cost_kind'] === 'material' ? ('material' as const) : ('wage' as const),
    }));
  }
}
