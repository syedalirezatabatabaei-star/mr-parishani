import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type { SettlementRefunds } from '../../common/settlement/settlement-refunds.port';
import { DATABASE, type Database } from '../../db/database.module';

/** SETTLEMENT_REFUNDS (task 5-2b): the refund steps of posted disputes, by borrower. */
@Injectable()
export class SettlementRefundsDirectory implements SettlementRefunds {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async downPaymentRefunds(
    tx?: SqlExecutor,
  ): Promise<{ entityId: string; borrowerPersonId: string; rial: bigint }[]> {
    const rows = await (tx ?? this.db).execute(sql`
      SELECT entity_id, borrower_person_id, sum(down_payment_rial)::text AS rial
      FROM settlement_dispute_postings WHERE step = 'refund' AND down_payment_rial > 0
      GROUP BY entity_id, borrower_person_id
    `);
    return rows.rows.map((r) => ({
      entityId: r['entity_id'] as string,
      borrowerPersonId: r['borrower_person_id'] as string,
      rial: BigInt(r['rial'] as string),
    }));
  }
}
