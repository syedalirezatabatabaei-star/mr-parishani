import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { DATABASE, type Database } from '../../db/database.module';
import { ALERT_SINK, type AlertSink } from '../../infra/ops/alerts';

export const SETTLEMENT_ALERT = 'settlement_mismatch' as const;

export interface SettlementIssue {
  readonly kind: 'payable_differs' | 'fee_receivable_differs' | 'payouts_differ';
  readonly statementId?: string;
  readonly accountId?: string;
  readonly expectedRial: string;
  readonly actualRial: string;
}

/**
 * The nightly reconciliation of settlement (task 5-1; doc 06 §8 test 5), read only, in one
 * REPEATABLE READ snapshot, apart from phase 1's ledger reconciliation (owner):
 *
 * cumulative per doctor node (task 5-4), so what a negative statement carries counts itself:
 *
 *   - doctor.payable = its payables not reversed − what live statements' offsets took from
 *     it − its payout orders confirmed (task 5-5);
 *   - doctor.fee_receivable = its fees above 0 not reversed − what live statements' offsets
 *     took from it.
 *
 * A finding is a count-only alert and a log line (rule 30), like 4-6b's.
 */
@Injectable()
export class SettlementReconciliation {
  private readonly logger = new Logger(SettlementReconciliation.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(ALERT_SINK) private readonly alerts: AlertSink,
  ) {}

  async run(): Promise<{ clean: boolean; checked: number; issues: SettlementIssue[] }> {
    const { issues, checked } = await this.db.transaction(
      async (tx) => {
        const found: SettlementIssue[] = [];
        let count = 0;
        const sides = [
          {
            kind: 'payable_differs' as const,
            code: 'doctor.payable',
            // A liability: what is owed is credit minus debit.
            sign: -1n,
            rows: await tx.execute(sql`
              SELECT entity_id, doctor_node_id, sum(x)::text AS owed FROM (
                SELECT entity_id, doctor_node_id,
                       CASE WHEN status <> 'reversed' THEN amount_rial ELSE 0 END AS x
                FROM doctor_payables
                UNION ALL
                SELECT s.entity_id, l.ref_id, -l.amount_rial
                FROM settlement_statement_lines l
                JOIN settlement_statements s ON s.id = l.statement_id
                WHERE l.line_type = 'offset_payable' AND s.status <> 'cancelled'
                UNION ALL
                SELECT o.entity_id, n.doctor_node_id, -n.amount_rial
                FROM payout_order_nodes n
                JOIN payout_orders o ON o.id = n.payout_id
                WHERE o.status = 'confirmed'
              ) t GROUP BY entity_id, doctor_node_id
            `),
          },
          {
            kind: 'fee_receivable_differs' as const,
            code: 'doctor.fee_receivable',
            // An asset: what is owed is debit minus credit.
            sign: 1n,
            rows: await tx.execute(sql`
              SELECT entity_id, doctor_node_id, sum(x)::text AS owed FROM (
                SELECT entity_id, doctor_node_id,
                       CASE WHEN status <> 'reversed' THEN amount_rial ELSE 0 END AS x
                FROM service_fees WHERE amount_rial > 0
                UNION ALL
                SELECT s.entity_id, l.ref_id, -l.amount_rial
                FROM settlement_statement_lines l
                JOIN settlement_statements s ON s.id = l.statement_id
                WHERE l.line_type = 'offset_fee' AND s.status <> 'cancelled'
              ) t GROUP BY entity_id, doctor_node_id
            `),
          },
        ];
        for (const side of sides) {
          for (const r of side.rows.rows) {
            count += 1;
            const expected = BigInt((r['owed'] as string | null) ?? '0');
            const account = await this.ledger.findAccount(
              {
                entityId: r['entity_id'] as string,
                code: side.code,
                ownerType: 'doctor',
                ownerId: r['doctor_node_id'] as string,
              },
              tx,
            );
            const b = account ? await this.ledger.balanceOf(account.id, undefined, tx) : null;
            const actual = b ? side.sign * (b.debitRial - b.creditRial) : 0n;
            if (actual !== expected) {
              found.push({
                kind: side.kind,
                ...(account ? { accountId: account.id } : {}),
                expectedRial: expected.toString(),
                actualRial: actual.toString(),
              });
            }
          }
        }
        // Task 5-5: an approved or paid statement's live orders pay exactly its payable.
        const statements = await tx.execute(sql`
          SELECT s.id, s.payable_rial::text AS payable,
                 coalesce(sum(o.amount_rial) FILTER (WHERE o.status <> 'failed'), 0)::text AS orders
          FROM settlement_statements s
          LEFT JOIN payout_orders o ON o.statement_id = s.id
          WHERE s.status IN ('approved', 'paid') AND s.payable_rial > 0
          GROUP BY s.id, s.payable_rial
        `);
        for (const r of statements.rows) {
          count += 1;
          if (r['payable'] !== r['orders']) {
            found.push({
              kind: 'payouts_differ',
              statementId: r['id'] as string,
              expectedRial: r['payable'] as string,
              actualRial: r['orders'] as string,
            });
          }
        }
        return { issues: found, checked: count };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const clean = issues.length === 0;
    this.logger.log(
      `settlement: ${String(checked)} accounts checked; ${clean ? 'clean' : `${String(issues.length)} issues`}`,
    );
    if (!clean) {
      await this.alerts.raise({
        code: SETTLEMENT_ALERT,
        message: `settlement reconciliation: ${String(issues.length)} accounts differ`,
      });
    }
    return { clean, checked, issues };
  }
}
