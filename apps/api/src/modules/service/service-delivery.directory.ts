import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type {
  FinalizedService,
  ServiceDeliveries,
} from '../../common/service/service-deliveries.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = sql.raw(`id, purse_id, credit_application_id, workplace_id, doctor_node_id,
  center_node_id, treatment_field_code, amount_rial::text AS amount_rial,
  to_char(finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finalized_at`);

/** See {@link ServiceDeliveries}: final services, read only (task 5-1). */
@Injectable()
export class ServiceDeliveryDirectory implements ServiceDeliveries {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async finalized(authorizationId: string, tx?: SqlExecutor): Promise<FinalizedService | null> {
    if (!UUID.test(authorizationId)) return null;
    const rows = await (tx ?? this.db).execute(sql`
      SELECT ${COLUMNS} FROM service_authorizations
      WHERE id = ${authorizationId} AND status = 'finalized'
    `);
    const row = rows.rows[0];
    return row ? view(row) : null;
  }

  async finalizedAfter(
    afterId: string | null,
    limit: number,
    tx?: SqlExecutor,
  ): Promise<FinalizedService[]> {
    const rows = await (tx ?? this.db).execute(sql`
      SELECT ${COLUMNS} FROM service_authorizations
      WHERE status = 'finalized' AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
      ORDER BY id LIMIT ${Math.max(1, Math.min(limit, 1000))}
    `);
    return rows.rows.map(view);
  }
}

function view(r: Record<string, unknown>): FinalizedService {
  return {
    authorizationId: r['id'] as string,
    purseId: r['purse_id'] as string,
    creditApplicationId: r['credit_application_id'] as string,
    workplaceId: r['workplace_id'] as string,
    doctorNodeId: r['doctor_node_id'] as string,
    centerNodeId: r['center_node_id'] as string,
    treatmentFieldCode: r['treatment_field_code'] as string,
    amountRial: BigInt(r['amount_rial'] as string),
    finalizedAt: new Date(r['finalized_at'] as string),
  };
}
