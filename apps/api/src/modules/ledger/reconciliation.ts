import { Inject, Injectable, Logger } from '@nestjs/common';
import { fromJalali, gregorianDay, toJalali } from '@sepehr/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { REPORTING_DATABASE, type ReportingDatabase } from '../../db/reporting.module';
import { ALERT_SINK, type Alert, type AlertSink } from '../../infra/ops/alerts';

export interface Discrepancy {
  readonly kind: 'balance_mismatch' | 'negative_balance';
  readonly accountId: string;
  readonly expectedDebitRial: bigint;
  readonly expectedCreditRial: bigint;
  readonly actualDebitRial: bigint;
  readonly actualCreditRial: bigint;
}

export interface EntityReport {
  readonly entityId: string;
  /** The Tehran calendar day reported, YYYY-MM-DD (Gregorian). */
  readonly reportDate: string;
  readonly dayDebitRial: bigint;
  readonly dayCreditRial: bigint;
  readonly totalDebitRial: bigint;
  readonly totalCreditRial: bigint;
  readonly balanced: boolean;
}

export interface ReconciliationResult {
  readonly runId: string;
  readonly clean: boolean;
  readonly accountsChecked: number;
  readonly journalsApplied: number;
  readonly discrepancies: readonly Discrepancy[];
  readonly reports: readonly EntityReport[];
  readonly overdueUnapplied: number;
  readonly alerts: readonly Alert[];
}

type Row = Record<string, unknown>;
const big = (v: unknown) => BigInt((v as string | null) ?? '0');

/**
 * The nightly reconciliation and financial health report (task 1-4, doc 02 §7, ADR-020).
 * Reads through the read-only reporting connection, in one REPEATABLE READ snapshot:
 *
 * - account_balances against the sum of the entries of the journals it has applied: any
 *   difference is a `balance_mismatch` (a journal still in the queue is not one);
 * - doc 02's invariants on the entries themselves: no purse or suspense account below
 *   zero (`negative_balance`);
 * - per legal entity, the reported day's and all time's debits against credits;
 * - journals not applied within `ops.ledger_lag_alert`.
 *
 * Writes the run, its discrepancies and reports (append-only, kept indefinitely) through
 * the primary database, and raises an alert for anything found.
 */
@Injectable()
export class LedgerReconciliation {
  private readonly logger = new Logger(LedgerReconciliation.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REPORTING_DATABASE) private readonly reporting: ReportingDatabase,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(ALERT_SINK) private readonly alerts: AlertSink,
  ) {}

  async run(now = new Date()): Promise<ReconciliationResult> {
    const startedAt = new Date();
    const { value: lag } = await this.config.resolve('ops.ledger_lag_alert', {}, now);
    // The report covers the Tehran day that ended at the last midnight before `now`.
    const dayEnd = fromJalali(toJalali(now));
    const dayStart = fromJalali(toJalali(new Date(dayEnd.getTime() - 1)));
    const reportDate = gregorianDay(toJalali(dayStart));

    const snapshot = await this.reporting.transaction(
      async (tx) => {
        const mismatches = await tx.execute<Row>(sql`
          WITH expected AS (
            SELECT e.account_id,
                   sum(e.amount_rial) FILTER (WHERE e.direction = 'debit') AS d,
                   sum(e.amount_rial) FILTER (WHERE e.direction = 'credit') AS c
            FROM ledger_entries e
            JOIN ledger_balance_applications ap ON ap.journal_entry_id = e.journal_entry_id
            GROUP BY e.account_id
          ), actual AS (
            SELECT account_id, debit_rial AS d, credit_rial AS c FROM account_balances
          )
          SELECT coalesce(x.account_id, y.account_id) AS account_id,
                 coalesce(x.d, 0)::text AS ed, coalesce(x.c, 0)::text AS ec,
                 coalesce(y.d, 0)::text AS ad, coalesce(y.c, 0)::text AS ac,
                 (coalesce(x.d, 0) <> coalesce(y.d, 0) OR coalesce(x.c, 0) <> coalesce(y.c, 0)) AS differs
          FROM expected x FULL JOIN actual y ON y.account_id = x.account_id
        `);
        const negatives = await tx.execute<Row>(sql`
          SELECT e.account_id,
                 coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'debit'), 0)::text AS d,
                 coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'credit'), 0)::text AS c
          FROM ledger_entries e
          JOIN ledger_accounts a ON a.id = e.account_id
          -- downpayment.held (ADR-034) is a liability: never more out than in.
          -- downpayment.refund_payable (ADR-036, task 4-8) and fee.refund_payable too.
          WHERE a.code LIKE 'purse.%'
             OR a.code IN ('suspense.unallocated', 'downpayment.held', 'downpayment.refund_payable',
                           'fee.refund_payable')
          GROUP BY e.account_id
          -- These carry credit balances; below zero means more debit than credit.
          HAVING coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'credit'), 0)
               < coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'debit'), 0)
        `);
        const trial = await tx.execute<Row>(sql`
          SELECT le.code AS entity_id,
                 coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'debit'), 0)::text AS td,
                 coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'credit'), 0)::text AS tc,
                 coalesce(sum(e.amount_rial) FILTER (
                   WHERE e.direction = 'debit' AND e.created_at >= ${dayStart} AND e.created_at < ${dayEnd}
                 ), 0)::text AS dd,
                 coalesce(sum(e.amount_rial) FILTER (
                   WHERE e.direction = 'credit' AND e.created_at >= ${dayStart} AND e.created_at < ${dayEnd}
                 ), 0)::text AS dc
          FROM legal_entities le
          LEFT JOIN journal_entries j ON j.entity_id = le.code
          LEFT JOIN ledger_entries e ON e.journal_entry_id = j.id
          GROUP BY le.code
          ORDER BY le.code
        `);
        const applied = await tx.execute<Row>(sql`
          SELECT count(*)::int AS applied,
                 (SELECT count(*)::int FROM journal_entries j
                  WHERE j.created_at < ${new Date(now.getTime() - lag.maxUnappliedSeconds * 1000)}
                    AND NOT EXISTS (
                      SELECT 1 FROM ledger_balance_applications ap WHERE ap.journal_entry_id = j.id
                    )) AS overdue
          FROM ledger_balance_applications
        `);
        return { mismatches, negatives, trial, applied };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const discrepancies: Discrepancy[] = [
      ...snapshot.mismatches.rows
        .filter((r) => r['differs'] === true)
        .map((r): Discrepancy => ({
          kind: 'balance_mismatch',
          accountId: r['account_id'] as string,
          expectedDebitRial: big(r['ed']),
          expectedCreditRial: big(r['ec']),
          actualDebitRial: big(r['ad']),
          actualCreditRial: big(r['ac']),
        })),
      ...snapshot.negatives.rows.map((r): Discrepancy => ({
        kind: 'negative_balance',
        accountId: r['account_id'] as string,
        expectedDebitRial: big(r['d']),
        expectedCreditRial: big(r['c']),
        actualDebitRial: big(r['d']),
        actualCreditRial: big(r['c']),
      })),
    ];
    const reports: EntityReport[] = snapshot.trial.rows.map((r) => {
      const report = {
        entityId: r['entity_id'] as string,
        reportDate,
        dayDebitRial: big(r['dd']),
        dayCreditRial: big(r['dc']),
        totalDebitRial: big(r['td']),
        totalCreditRial: big(r['tc']),
      };
      return {
        ...report,
        balanced:
          report.dayDebitRial === report.dayCreditRial &&
          report.totalDebitRial === report.totalCreditRial,
      };
    });
    const journalsApplied = snapshot.applied.rows[0]?.['applied'] as number;
    const overdueUnapplied = snapshot.applied.rows[0]?.['overdue'] as number;
    const mismatches = discrepancies.filter((d) => d.kind === 'balance_mismatch').length;
    const invariantViolations = discrepancies.length - mismatches;
    const unbalanced = reports.filter((r) => !r.balanced);

    const alerts: Alert[] = [];
    if (mismatches > 0) {
      alerts.push({
        code: 'ledger_mismatch',
        message: `${String(mismatches)} account balances differ from the sum of their entries`,
      });
    }
    if (invariantViolations > 0) {
      alerts.push({
        code: 'ledger_invariant',
        message: `${String(invariantViolations)} purse or suspense accounts are below zero`,
      });
    }
    if (unbalanced.length > 0) {
      alerts.push({
        code: 'trial_balance_off',
        message: `debits differ from credits for ${unbalanced.map((r) => r.entityId).join(', ')}`,
      });
    }
    if (overdueUnapplied > 0) {
      alerts.push({
        code: 'ledger_lag',
        message: `${String(overdueUnapplied)} journals not applied to balances within ${String(lag.maxUnappliedSeconds)}s`,
      });
    }

    const runId = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO ledger_reconciliation_runs (
          started_at, finished_at, accounts_checked, journals_applied, mismatches,
          invariant_violations, unbalanced_entities, overdue_unapplied, clean
        ) VALUES (
          ${startedAt}, now(), ${snapshot.mismatches.rows.length}, ${journalsApplied},
          ${mismatches}, ${invariantViolations}, ${unbalanced.length}, ${overdueUnapplied},
          ${alerts.length === 0}
        )
        RETURNING id
      `);
      const id = inserted.rows[0]?.['id'] as string;
      if (discrepancies.length > 0) {
        const values: SQL[] = discrepancies.map(
          (d) => sql`(${id}, ${d.kind}, ${d.accountId},
            ${d.expectedDebitRial.toString()}::bigint, ${d.expectedCreditRial.toString()}::bigint,
            ${d.actualDebitRial.toString()}::bigint, ${d.actualCreditRial.toString()}::bigint)`,
        );
        await tx.execute(sql`
          INSERT INTO ledger_discrepancies (
            run_id, kind, account_id, expected_debit_rial, expected_credit_rial,
            actual_debit_rial, actual_credit_rial
          ) VALUES ${sql.join(values, sql`, `)}
        `);
      }
      const reportValues: SQL[] = reports.map(
        (r) => sql`(${id}, ${r.entityId}, ${r.reportDate}::date,
          ${r.dayDebitRial.toString()}::bigint, ${r.dayCreditRial.toString()}::bigint,
          ${r.totalDebitRial.toString()}::bigint, ${r.totalCreditRial.toString()}::bigint, ${r.balanced})`,
      );
      if (reportValues.length > 0) {
        await tx.execute(sql`
          INSERT INTO ledger_daily_reports (
            run_id, entity_id, report_date, day_debit_rial, day_credit_rial,
            total_debit_rial, total_credit_rial, balanced
          ) VALUES ${sql.join(reportValues, sql`, `)}
        `);
      }
      return id;
    });

    // Immediately, for everything found (task 1-4): on-call SMS, logs, Grafana.
    for (const alert of alerts) await this.alerts.raise(alert);
    if (alerts.length === 0) this.logger.log(`ledger reconciliation ${runId}: clean`);

    return {
      runId,
      clean: alerts.length === 0,
      accountsChecked: snapshot.mismatches.rows.length,
      journalsApplied,
      discrepancies,
      reports,
      overdueUnapplied,
      alerts,
    };
  }
}
