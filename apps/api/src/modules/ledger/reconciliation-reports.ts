import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { REPORTING_DATABASE, type ReportingDatabase } from '../../db/reporting.module';

/**
 * Reading past reconciliation runs, their discrepancies and daily reports (task 1-4), for
 * accounting and the auditor. Through the read-only reporting connection (ADR-012).
 */
@Injectable()
export class ReconciliationReports {
  constructor(@Inject(REPORTING_DATABASE) private readonly reporting: ReportingDatabase) {}

  async latest(limit: number) {
    const runs = await this.reporting.execute(sql`
      SELECT id, clean, accounts_checked, journals_applied, mismatches, invariant_violations,
             unbalanced_entities, overdue_unapplied,
             to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
      FROM ledger_reconciliation_runs
      ORDER BY started_at DESC, id DESC
      LIMIT ${limit}
    `);
    const ids = runs.rows.map((r) => r['id'] as string);
    if (ids.length === 0) return [];
    const discrepancies = await this.reporting.execute(sql`
      SELECT run_id, kind, account_id, expected_debit_rial::text, expected_credit_rial::text,
             actual_debit_rial::text, actual_credit_rial::text
      FROM ledger_discrepancies WHERE run_id = ANY (${sql.param(ids)}::uuid[])
      ORDER BY created_at, id
    `);
    const reports = await this.reporting.execute(sql`
      SELECT run_id, entity_id, report_date::text, day_debit_rial::text, day_credit_rial::text,
             total_debit_rial::text, total_credit_rial::text, balanced
      FROM ledger_daily_reports WHERE run_id = ANY (${sql.param(ids)}::uuid[])
      ORDER BY entity_id
    `);
    return runs.rows.map((run) => ({
      id: run['id'],
      startedAt: run['started_at'],
      clean: run['clean'],
      accountsChecked: run['accounts_checked'],
      journalsApplied: run['journals_applied'],
      mismatches: run['mismatches'],
      invariantViolations: run['invariant_violations'],
      unbalancedEntities: run['unbalanced_entities'],
      overdueUnapplied: run['overdue_unapplied'],
      discrepancies: discrepancies.rows
        .filter((d) => d['run_id'] === run['id'])
        .map((d) => ({
          kind: d['kind'],
          accountId: d['account_id'],
          expectedDebitRial: d['expected_debit_rial'],
          expectedCreditRial: d['expected_credit_rial'],
          actualDebitRial: d['actual_debit_rial'],
          actualCreditRial: d['actual_credit_rial'],
        })),
      reports: reports.rows
        .filter((r) => r['run_id'] === run['id'])
        .map((r) => ({
          entityId: r['entity_id'],
          reportDate: r['report_date'],
          dayDebitRial: r['day_debit_rial'],
          dayCreditRial: r['day_credit_rial'],
          totalDebitRial: r['total_debit_rial'],
          totalCreditRial: r['total_credit_rial'],
          balanced: r['balanced'],
        })),
    }));
  }
}
