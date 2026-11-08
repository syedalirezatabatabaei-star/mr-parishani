import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import type {
  ContractPenaltyTerms,
  ContractTermsPort,
} from '../../common/contract/contract-terms.port';
import { DATABASE, type Database } from '../../db/database.module';
import { jalaliDay } from './contract.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** See {@link ContractTermsPort}: the rate of the application's live (not failed) contract. */
@Injectable()
export class ContractTermsService implements ContractTermsPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  async penaltyOf(
    creditApplicationId: string,
    tx?: SqlExecutor,
  ): Promise<ContractPenaltyTerms | null> {
    if (!UUID.test(creditApplicationId)) return null;
    const rows = await (tx ?? this.db).execute(sql`
      SELECT c.id, t.penalty_bps,
             to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS made_at
      FROM contracts c
      LEFT JOIN contract_penalty_terms t ON t.contract_id = c.id
      WHERE c.credit_application_id = ${creditApplicationId} AND c.status <> 'failed'
      ORDER BY c.created_at DESC
      LIMIT 1
    `);
    const row = rows.rows[0];
    if (!row) return null;
    const contractId = row['id'] as string;
    if (row['penalty_bps'] !== null && row['penalty_bps'] !== undefined) {
      return { contractId, penaltyBps: Number(row['penalty_bps']) };
    }
    // Made before 0044: the configuration in force when it was made (its own time, rule 16).
    const then = new Date(row['made_at'] as string);
    const rate = await this.config.resolve('repayment.cancellation_penalty_bps', {}, then);
    return { contractId, penaltyBps: rate.value };
  }

  async applicationsWithPrintedDueOn(days: readonly string[], tx?: SqlExecutor): Promise<string[]> {
    if (days.length === 0) return [];
    // The table is stored as printed: Jalali days in Persian digits (contract.service).
    const printed = days.map(jalaliDay);
    const rows = await (tx ?? this.db).execute(sql`
      SELECT DISTINCT c.credit_application_id AS id
      FROM contracts c
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(c.fields->>'installments.table', '[]')::jsonb
      ) AS i(row)
      WHERE c.status <> 'failed' AND NOT c.sample AND c.deleted_at IS NULL
        AND i.row->>'dueOn' IN (${sql.join(
          printed.map((d) => sql`${d}`),
          sql`, `,
        )})
      ORDER BY 1
    `);
    return rows.rows.map((r) => r['id'] as string);
  }
}
